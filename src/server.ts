import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { v4 as uuidv4 } from 'uuid';
import { env } from './config/env';
import { logger } from './utils/logger';
import { prisma } from './db/prisma';
import { PaymentService } from './services/paymentService';
import { CreditReportingService } from './services/creditReportingService';
import { rentCronWorker, rentCronQueue, scheduleCron } from './services/cronService';
import { sendWhatsAppMessage } from './services/whatsappService';
import { register } from 'prom-client';

const app = express();

// Security and Logging
app.use(helmet());
app.use(cors({ origin: env.APP_URL }));
app.use(pinoHttp({
  logger,
  genReqId: () => uuidv4(),
  autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' }
}));

// Rate limiting (Redis-backed in cluster, in-memory protection for single container)
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// ---------------- STRIPE WEBHOOK (RAW BODY PARSER) ----------------
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'] as string;
  try {
    await PaymentService.handleStripeWebhook(req.body, signature);
    res.status(200).send('OK');
  } catch (error: any) {
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

// JSON and URL-encoded body parsers for all other application routes
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------- ROOT & OBSERVABILITY ROUTES ----------------

// Root route: Instant health check and API overview
app.get('/', (req, res) => {
  res.status(200).json({
    platform: 'RentFlow Autonomous Rent Engine',
    version: '1.0.0',
    status: 'OPERATIONAL',
    environment: env.NODE_ENV,
    endpoints: {
      health: '/health',
      metrics: '/metrics',
      testCron: '/test-cron',
      testWhatsApp: '/test-whatsapp'
    }
  });
});

// Database and Redis readiness probe
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'UP', timestamp: new Date() });
  } catch (e) {
    res.status(503).json({ status: 'DOWN', error: 'Database unreachable' });
  }
});

// Prometheus metrics scraper
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------- TWILIO WEBHOOK ----------------
app.post('/webhooks/twilio', async (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  logger.info({ MessageSid, MessageStatus }, 'Twilio Delivery Status');
  res.status(200).send('OK');
});

// ---------------- TEST & DIAGNOSTIC ROUTES ----------------

// 1-click test trigger directly from browser: Fires full assessment batch
app.get('/test-cron', async (req, res) => {
  try {
    logger.info('Manual test-cron triggered from browser endpoint');
    await rentCronQueue.add('manual-trigger', { dryRun: false });
    res.status(200).json({
      status: 'SUCCESS',
      message: 'Rent assessment job queued! Check your WhatsApp chat and Render logs.'
    });
  } catch (err: any) {
    logger.error({ err }, 'Failed to queue manual test cron');
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// 1-click test to verify Twilio credentials and WhatsApp connectivity directly
app.get('/test-whatsapp', async (req, res) => {
  try {
    const testNumber = '+27781817491';
    const sent = await sendWhatsAppMessage(
      testNumber,
      'rent_reminder_sufficient_balance',
      {
        tenantName: 'Mosa Ramollo',
        amount: '1500.00',
        currency: 'ZAR',
        checkoutLink: 'https://checkout.stripe.com/test'
      },
      true
    );

    if (sent) {
      res.status(200).json({ status: 'DELIVERED', message: `WhatsApp sent to ${testNumber}!` });
    } else {
      res.status(500).json({ status: 'FAILED', message: 'Twilio refused delivery. Check Render logs for error code.' });
    }
  } catch (err: any) {
    logger.error({ err }, 'Direct WhatsApp test failed');
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// ---------------- ADMIN ROUTES (PROTECTED) ----------------
const adminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.headers['x-admin-key'] !== env.ADMIN_API_KEY) return res.status(401).send('Unauthorized');
  next();
};

app.post('/admin/run-cron', adminAuth, async (req, res) => {
  await rentCronQueue.add('manual-trigger', { dryRun: req.body.dryRun });
  res.status(202).json({ message: 'Cron job queued' });
});

app.get('/admin/credit-report/:month/:year', adminAuth, async (req, res) => {
  try {
    const csv = await CreditReportingService.generateCreditReport(
      parseInt(req.params.month), 
      parseInt(req.params.year), 
      'admin-system'
    );
    res.header('Content-Type', 'text/csv');
    res.attachment(`credit_report_${req.params.year}_${req.params.month}.csv`);
    res.send(csv);
  } catch (error) {
    logger.error({ err: error }, 'Credit report generation failed');
    res.status(500).send('Internal Server Error');
  }
});

// Global Error Handler (PCI-DSS & Security: never leak stack traces)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled Exception');
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------------- SERVER BOOTSTRAP ----------------
const server = app.listen(env.PORT, async () => {
  logger.info(`RentFlow server running on port ${env.PORT}`);
  await scheduleCron();
});

// Graceful Shutdown: drains BullMQ queues, cleans DB connections
const shutdown = async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(async () => {
    await rentCronWorker.close();
    await rentCronQueue.close();
    await prisma.$disconnect();
    logger.info('Closed DB, Redis, and Web Server.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
