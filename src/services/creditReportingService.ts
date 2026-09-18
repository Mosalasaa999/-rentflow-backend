import { prisma } from '../db/prisma';
import { ActorType } from '@prisma/client';
import { logger } from '../utils/logger';
import { parse } from 'json2csv';

export class CreditReportingService {
  static async generateCreditReport(month: number, year: number, adminId: string): Promise<string> {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const records = await prisma.paymentRecord.findMany({
      where: {
        dueDate: { gte: startDate, lte: endDate },
        tenant: { creditScoreOptIn: true },
        reportedToCreditBureau: false
      },
      include: { tenant: true, lease: true }
    });

    const reportData = records.map(record => {
      const isLate = record.paymentDate 
        ? record.paymentDate > new Date(record.dueDate.getTime() + record.lease.gracePeriodDays * 86400000) 
        : true;
      
      const status = record.status === 'PAID' ? (isLate ? 'LATE' : 'ON_TIME') : 'MISSED';

      return {
        tenantName: record.tenant.name,
        nationalId: record.tenant.nationalId || 'NOT_PROVIDED',
        leaseReference: record.lease.id,
        reportingPeriod: `${year}-${month.toString().padStart(2, '0')}`,
        paymentStatus: status,
        amount: record.amount.toString(),
        currency: record.currency,
        paymentMethod: record.paymentMethod || 'UNKNOWN',
        consentHash: `consent_${record.tenant.id}`
      };
    });

    if (reportData.length > 0) {
      const ids = records.map(r => r.id);
      await prisma.paymentRecord.updateMany({
        where: { id: { in: ids } },
        data: { reportedToCreditBureau: true, reportedAt: new Date() }
      });
    }

    await prisma.auditLog.create({
      data: {
        actorType: ActorType.ADMIN,
        actorId: adminId,
        action: 'CREDIT_REPORT_EXPORTED',
        entityType: 'System',
        entityId: 'ALL',
        metadata: { month, year, rowCount: reportData.length }
      }
    });

    logger.info({ rowCount: reportData.length }, 'Credit report generated');
    return parse(reportData);
  }
}
