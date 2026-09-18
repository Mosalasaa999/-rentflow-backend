import Stripe from 'stripe';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { sendWhatsAppMessage } from './whatsappService';
import { PaymentStatus, PaymentMethod, ActorType } from '@prisma/client';

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

export class PaymentService {
  static async createCheckoutSession(
    lease: any,
    tenant: any,
    amount: number,
    idempotencyKey: string,
    billingPeriod: string
  ): Promise<{ url: string; sessionId: string }> {
    const existing = await prisma.paymentRecord.findUnique({ where: { idempotencyKey } });
    if (existing?.stripeSessionId) {
      const session = await stripe.checkout.sessions.retrieve(existing.stripeSessionId);
      return { url: session.url!, sessionId: session.id };
    }

    const session = await stripe.checkout.sessions.create(
      {
        payment_method_types: ['card'],
        mode: 'payment',
        customer_email: tenant.email || undefined,
        line_items: [
          {
            price_data: {
              currency: lease.currency.toLowerCase(),
              product_data: {
                name: `Rent Payment - ${billingPeriod}`,
                description: `Lease ID: ${lease.id}`,
              },
              unit_amount: Math.round(amount * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${env.APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.APP_URL}/payment/cancel`,
        metadata: {
          leaseId: lease.id,
          tenantId: tenant.id,
          billingPeriod,
          idempotencyKey,
        },
      },
      { idempotencyKey: `sess_${idempotencyKey}` }
    );

    return { url: session.url!, sessionId: session.id };
  }

  static async createSplitPaymentLink(lease: any, tenant: any, remainingAmount: number): Promise<string> {
    const price = await stripe.prices.create({
      currency: lease.currency.toLowerCase(),
      unit_amount: Math.round(remainingAmount * 100),
      product_data: { name: `Partial Rent Payment - Lease ${lease.id}` },
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { leaseId: lease.id, tenantId: tenant.id, isPartial: 'true' },
    });

    return paymentLink.url;
  }

  static async handleStripeWebhook(payload: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      logger.error({ err }, 'Stripe webhook signature verification failed');
      throw new Error('Invalid signature');
    }

    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { externalEventId: event.id }
    });

    if (existingEvent) {
      logger.info({ eventId: event.id }, 'Webhook already processed');
      return;
    }

    await prisma.webhookEvent.create({
      data: {
        provider: 'STRIPE',
        externalEventId: event.id,
        payload: event as any,
      }
    });

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const { leaseId, idempotencyKey } = session.metadata!;
          
          await prisma.$transaction(async (tx) => {
            const record = await tx.paymentRecord.update({
              where: { idempotencyKey },
              data: {
                status: PaymentStatus.PAID,
                paymentDate: new Date(),
                stripePaymentIntentId: session.payment_intent as string,
                paymentMethod: PaymentMethod.CARD,
              },
              include: { tenant: true, lease: { include: { landlord: true } } }
            });

            await tx.auditLog.create({
              data: {
                actorType: ActorType.SYSTEM,
                action: 'PAYMENT_COMPLETED',
                entityType: 'PaymentRecord',
                entityId: record.id,
                metadata: { stripeSessionId: session.id }
              }
            });

            await sendWhatsAppMessage(
              record.tenant.phoneNumber,
              'payment_confirmation',
              { tenantName: record.tenant.name, amount: record.amount.toString(), currency: record.currency, receiptId: record.id },
              record.tenant.whatsappOptIn
            );
          });
          break;
        }

        case 'checkout.session.expired': {
          const session = event.data.object as Stripe.Checkout.Session;
          await prisma.paymentRecord.updateMany({
            where: { idempotencyKey: session.metadata?.idempotencyKey },
            data: { status: PaymentStatus.FAILED, failureReason: 'Session expired' }
          });
          break;
        }

        case 'charge.dispute.created': {
          const dispute = event.data.object as Stripe.Dispute;
          logger.warn({ dispute }, 'Payment disputed by tenant!');
          break;
        }
      }

      await prisma.webhookEvent.update({
        where: { externalEventId: event.id },
        data: { processedAt: new Date() }
      });
    } catch (error) {
      logger.error({ err: error, eventId: event.id }, 'Error processing Stripe webhook');
      throw error;
    }
  }
}
