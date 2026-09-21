import { Worker, Queue } from 'bullmq';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { balanceProvider } from './bankBalanceProvider';
import { PaymentService } from './paymentService';
import { sendWhatsAppMessage } from './whatsappService';
import { PaymentStatus, ActorType } from '@prisma/client';
import { register, Counter } from 'prom-client';

const redisConnection = { url: env.REDIS_URL };

export const rentCronQueue = new Queue('rent-cron', { connection: redisConnection });

const remindersSentCounter = new Counter({
  name: 'rent_reminders_sent_total',
  help: 'Total rent reminders sent via WhatsApp'
});
const balanceChecksFailedCounter = new Counter({
  name: 'balance_checks_failed_total',
  help: 'Total failed open banking balance checks'
});
register.registerMetric(remindersSentCounter);
register.registerMetric(balanceChecksFailedCounter);

export const rentCronWorker = new Worker('rent-cron', async (job) => {
  const isDryRun = job.data?.dryRun || false;
  logger.info({ isDryRun }, 'Starting daily rent assessment batch');

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const leases = await prisma.lease.findMany({
    where: { status: 'ACTIVE' },
    include: { tenant: true, landlord: true }
  });

  logger.info({ count: leases.length }, 'Active leases found in database');

  for (const lease of leases) {
    try {
      // Due date set to 23:59:59 of the due day
      let dueDate = new Date(now.getFullYear(), now.getMonth(), lease.dueDayOfMonth, 23, 59, 59);
      if (dueDate < startOfDay) {
        dueDate = new Date(now.getFullYear(), now.getMonth() + 1, lease.dueDayOfMonth, 23, 59, 59);
      }

      const diffHours = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      logger.info({ leaseId: lease.id, diffHours, reminderHours: lease.reminderHoursBeforeDue }, 'Evaluating lease window');

      // Check if within reminder window (positive hours remaining or due today)
      if (diffHours >= 0 && diffHours <= lease.reminderHoursBeforeDue) {
        const billingPeriod = `${dueDate.getFullYear()}-${(dueDate.getMonth() + 1).toString().padStart(2, '0')}`;
        const idempotencyKey = `lease_${lease.id}_${billingPeriod}`;

        const existingRecord = await prisma.paymentRecord.findUnique({ where: { idempotencyKey } });
        if (existingRecord && [PaymentStatus.PAID, PaymentStatus.PENDING].includes(existingRecord.status)) {
          logger.info({ idempotencyKey }, 'Payment record already exists for this cycle, skipping');
          continue;
        }

        const balance = await balanceProvider.getBalance(lease.tenant.bankAccessToken);
        
        if (balance === null) {
          balanceChecksFailedCounter.inc();
          await prisma.auditLog.create({
            data: { actorType: ActorType.SYSTEM, action: 'TOKEN_EXPIRED', entityType: 'Lease', entityId: lease.id }
          });
          continue;
        }

        const rentAmount = Number(lease.rentAmount);

        if (!isDryRun) {
          if (balance >= rentAmount) {
            const { url, sessionId } = await PaymentService.createCheckoutSession(lease, lease.tenant, rentAmount, idempotencyKey, billingPeriod);
            
            await prisma.paymentRecord.upsert({
              where: { idempotencyKey },
              update: { stripeSessionId: sessionId },
              create: {
                idempotencyKey,
                leaseId: lease.id,
                amount: rentAmount,
                currency: lease.currency,
                dueDate: dueDate,
                status: PaymentStatus.PENDING,
                stripeSessionId: sessionId
              }
            });

            const sent = await sendWhatsAppMessage(
              lease.tenant.phoneNumber, 
              'rent_reminder_sufficient_balance', 
              { tenantName: lease.tenant.name, amount: rentAmount.toString(), currency: lease.currency, checkoutLink: url },
              lease.tenant.whatsappOptIn
            );
            
            if (sent) remindersSentCounter.inc();
          } else {
            const splitLink = await PaymentService.createSplitPaymentLink(lease, lease.tenant, rentAmount);
            
            await prisma.auditLog.create({
              data: { actorType: ActorType.SYSTEM, action: 'INSUFFICIENT_BALANCE', entityType: 'Lease', entityId: lease.id, metadata: { balance, rentAmount } }
            });

            await sendWhatsAppMessage(
              lease.tenant.phoneNumber, 
              'rent_reminder_insufficient_balance', 
              { tenantName: lease.tenant.name, amount: rentAmount.toString(), currency: lease.currency, alternateLink: splitLink },
              lease.tenant.whatsappOptIn
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err, leaseId: lease.id }, 'Failed to process lease in cron job');
    }
  }
}, { connection: redisConnection });

export async function scheduleCron() {
  await rentCronQueue.add('daily-assessment', {}, {
    repeat: {
      pattern: '0 8 * * *',
      tz: 'Africa/Johannesburg'
    }
  });
  logger.info('Scheduled daily rent cron job');
}
