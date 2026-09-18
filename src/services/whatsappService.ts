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

  let contentSid = ''; 
  let contentVariables = JSON.stringify(variables);

  switch (templateName) {
    case 'rent_reminder_sufficient_balance':
      contentSid = 'HX1234567890abcdef1234567890abcdef';
      break;
    case 'rent_reminder_insufficient_balance':
      contentSid = 'HXabcdef1234567890abcdef1234567890';
      break;
    case 'payment_confirmation':
      contentSid = 'HX0987654321fedcba0987654321fedcba';
      break;
    default:
      throw new Error(`Unknown template: ${templateName}`);
  }

  try {
    await delay(100);

    const message = await client.messages.create({
      from: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${toPhoneNumber}`,
      contentSid,
      contentVariables,
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

    logger.info({ sid: message.sid, to: toPhoneNumber }, 'WhatsApp message sent');
    return true;
  } catch (error: any) {
    logger.error({ err: error, to: toPhoneNumber }, 'Twilio WhatsApp sending failed');
    return false;
  }
}
