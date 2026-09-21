import twilio from 'twilio';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { ActorType } from '@prisma/client';

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

interface TemplateVariables {
  [key: string]: string;
}

export async function sendWhatsAppMessage(
  toPhoneNumber: string,
  templateName: string,
  variables: TemplateVariables,
  isOptedIn: boolean = true
): Promise<boolean> {
  if (!isOptedIn && templateName !== 'legal_notice') {
    logger.info({ to: toPhoneNumber, templateName }, 'Skipped WhatsApp send: Tenant opted out');
    return false;
  }

  // Generate dynamic message content with 1-tap checkout links
  let body = '';
  switch (templateName) {
    case 'rent_reminder_sufficient_balance':
      body = `🏠 *RentFlow Reminder*\n\nHi ${variables.tenantName}!\n\nYour rent payment of *${variables.currency} ${variables.amount}* is due.\n\nPay with 1-tap via Apple Pay, Google Pay, or Card:\n👉 ${variables.checkoutLink}\n\n_Protected by Open Banking overdraft prevention._`;
      break;
    case 'rent_reminder_insufficient_balance':
      body = `⚠️ *RentFlow Alert*\n\nHi ${variables.tenantName},\n\nYour rent of *${variables.currency} ${variables.amount}* is due soon. To prevent bank overdraft fees, you can pay using an alternate card or split payment:\n👉 ${variables.alternateLink}`;
      break;
    case 'payment_confirmation':
      body = `🎉 *Payment Confirmed!*\n\nHi ${variables.tenantName}, your rent payment of *${variables.currency} ${variables.amount}* was successful.\n\nReceipt ID: ${variables.receiptId}\n_Reported to credit bureau for credit score building._`;
      break;
    default:
      body = `RentFlow update for ${variables.tenantName}`;
  }

  try {
    await delay(100); // Throttling protection

    const message = await client.messages.create({
      from: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${toPhoneNumber}`,
      body,
    });

    await prisma.auditLog.create({
      data: {
        actorType: ActorType.SYSTEM,
        action: 'WHATSAPP_SENT',
        entityType: 'Tenant',
        entityId: toPhoneNumber,
        metadata: { messageSid: message.sid, template: templateName }
      }
    });

    logger.info({ sid: message.sid, to: toPhoneNumber }, 'WhatsApp message sent successfully');
    return true;
  } catch (error: any) {
    logger.error({ err: error, to: toPhoneNumber }, 'Twilio WhatsApp sending failed');
    return false;
  }
}
