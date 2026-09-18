import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const ALGORITHM = 'aes-256-gcm';

export function decryptToken(encryptedToken: string): string {
  const parts = encryptedToken.split(':');
  const iv = Buffer.from(parts.shift()!, 'hex');
  const authTag = Buffer.from(parts.shift()!, 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(env.ENCRYPTION_KEY, 'hex'), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedText, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export interface BankBalanceProvider {
  getBalance(encryptedAccessToken: string): Promise<number | null>;
}

export class PlaidBalanceProvider implements BankBalanceProvider {
  private client: PlaidApi;

  constructor() {
    const configuration = new Configuration({
      basePath: PlaidEnvironments[env.PLAID_ENV as keyof typeof PlaidEnvironments] || PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
          'PLAID-SECRET': env.PLAID_SECRET,
        },
      },
    });
    this.client = new PlaidApi(configuration);
  }

  async getBalance(encryptedAccessToken: string): Promise<number | null> {
    try {
      const accessToken = decryptToken(encryptedAccessToken);
      const response = await this.client.accountsBalanceGet({ access_token: accessToken });
      
      const totalAvailable = response.data.accounts
        .filter(acc => acc.type === 'depository' && acc.balances.available != null)
        .reduce((sum, acc) => sum + (acc.balances.available || 0), 0);

      return totalAvailable;
    } catch (error: any) {
      logger.error({ err: error }, 'Plaid API error fetching balance');
      if (error?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED') {
        return null;
      }
      throw error;
    }
  }
}

export class MockBalanceProvider implements BankBalanceProvider {
  async getBalance(encryptedAccessToken: string): Promise<number | null> {
    if (encryptedAccessToken.includes('EXPIRED')) return null;
    return 15000.00;
  }
}

export const balanceProvider = env.NODE_ENV === 'production' 
  ? new PlaidBalanceProvider() 
  : new MockBalanceProvider();
