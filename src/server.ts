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
import { register } from 'prom-client';

const app = express();

app.use(helmet());
app.use(cors({ origin: env.APP_URL }));
app.use(pinoHttp({
  logger,
  genReqId: () => uuidv4(),
  autoLogging: { ignore: (req) => req.url === '/health' }
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'] as string;
  try {
    await PaymentService.handleStripeWebhook(req.body, signature);
    res.status(200).send('OK');
  } catch (error: any) {
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.post('/webhooks/twilio', async (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  logger.info({ MessageSid, MessageStatus }, 'Twilio Delivery Status');
  res.status(200).send('OK');
});

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'UP', timestamp: new Date() });
  } catch (e) {
    res.status(503).json({ status: 'DOWN', error: 'Database unreachable' });
  }
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

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

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled Exception');
  res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(env.PORT, async () => {
  logger.info(`RentFlow server running on port ${env.PORT}`);
  await scheduleCron();
});

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
