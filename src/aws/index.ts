import { AwsClients } from './types';
import { createMockAwsClients } from './mockClients';
import { createRealAwsClients } from './realClients';

interface GetAwsClientsOptions {
  workspaceId: string;
  roleArn: string;
  awsAccountId: string;
}

/**
 * Factory that returns AWS clients.
 * When AWS_MOCK=true, returns deterministic mock clients.
 * Otherwise, returns real AWS SDK v3 clients using STS AssumeRole.
 */
export function getAwsClients(options: GetAwsClientsOptions): AwsClients {
  const isMock = process.env.AWS_MOCK === 'true';

  if (isMock) {
    return createMockAwsClients(options.workspaceId);
  }

  return createRealAwsClients(options.roleArn, options.awsAccountId);
}

export type { AwsClients } from './types';
