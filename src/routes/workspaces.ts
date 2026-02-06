import { FastifyInstance } from 'fastify';
import prisma from '../db';
import { authMiddleware } from '../middleware/auth';
import { getAwsClients } from '../aws';
import { syncWorkspaceResources } from '../services/resourceSync';

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // Create workspace
  app.post(
    '/api/workspaces',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { roleArn, awsAccountId, name } = request.body as {
        roleArn: string;
        awsAccountId: string;
        name?: string;
      };

      if (!roleArn || !awsAccountId) {
        return reply
          .status(400)
          .send({ error: 'roleArn and awsAccountId are required' });
      }

      // Ensure dev user exists (stub)
      let user = await prisma.user.findUnique({
        where: { id: request.userId },
      });
      if (!user) {
        user = await prisma.user.create({
          data: {
            id: request.userId,
            email: 'dev@example.com',
            name: 'Dev User',
            role: 'admin',
          },
        });
      }

      const workspace = await prisma.workspace.create({
        data: {
          name: name || `AWS Account ${awsAccountId}`,
          roleArn,
          awsAccountId,
          userId: request.userId,
          status: 'pending',
        },
      });

      return reply.status(201).send(workspace);
    }
  );

  // List workspaces
  app.get(
    '/api/workspaces',
    { preHandler: authMiddleware },
    async (request, _reply) => {
      const workspaces = await prisma.workspace.findMany({
        where: { userId: request.userId },
        include: {
          _count: {
            select: { recommendations: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return workspaces;
    }
  );

  // Test connection for a workspace
  app.post(
    '/api/workspaces/:id/test-connection',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const workspace = await prisma.workspace.findFirst({
        where: { id, userId: request.userId },
      });

      if (!workspace) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      try {
        const clients = getAwsClients({
          workspaceId: workspace.id,
          roleArn: workspace.roleArn,
          awsAccountId: workspace.awsAccountId,
        });

        const connected = await clients.testConnection();

        const updated = await prisma.workspace.update({
          where: { id },
          data: { status: connected ? 'connected' : 'error' },
        });

        return { status: updated.status, message: 'Connection test successful' };
      } catch (error) {
        await prisma.workspace.update({
          where: { id },
          data: { status: 'error' },
        });

        return reply.status(500).send({
          status: 'error',
          message:
            error instanceof Error ? error.message : 'Connection test failed',
        });
      }
    }
  );

  // List recommendations for a workspace
  app.get(
    '/api/workspaces/:id/recommendations',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.query as { status?: string };

      const workspace = await prisma.workspace.findFirst({
        where: { id, userId: request.userId },
      });

      if (!workspace) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      const where: Record<string, unknown> = { workspaceId: id };
      if (status) {
        where.status = status;
      }

      const recommendations = await prisma.recommendation.findMany({
        where,
        orderBy: { estimatedMonthlySavings: 'desc' },
      });

      const summary = {
        totalRecommendations: recommendations.length,
        totalEstimatedSavings: recommendations.reduce(
          (sum, r) => sum + r.estimatedMonthlySavings,
          0
        ),
        byStatus: {
          new: recommendations.filter((r) => r.status === 'new').length,
          acknowledged: recommendations.filter((r) => r.status === 'acknowledged')
            .length,
          dismissed: recommendations.filter((r) => r.status === 'dismissed')
            .length,
        },
      };

      return { summary, recommendations };
    }
  );

  // Get cost data for a workspace
  app.get(
    '/api/workspaces/:id/costs',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const workspace = await prisma.workspace.findFirst({
        where: { id, userId: request.userId },
      });

      if (!workspace) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      const clients = getAwsClients({
        workspaceId: workspace.id,
        roleArn: workspace.roleArn,
        awsAccountId: workspace.awsAccountId,
      });

      const costData = await clients.getCostData();
      return costData;
    }
  );

  // Trigger resource sync for a workspace
  app.post(
    '/api/workspaces/:id/sync',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const workspace = await prisma.workspace.findFirst({
        where: { id, userId: request.userId },
      });

      if (!workspace) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      try {
        const result = await syncWorkspaceResources(workspace.id);

        await prisma.workspace.update({
          where: { id },
          data: { status: 'connected' },
        });

        return {
          status: 'completed',
          message: `Synced ${result.total} resources`,
          ...result,
        };
      } catch (error) {
        return reply.status(500).send({
          status: 'error',
          message: error instanceof Error ? error.message : 'Sync failed',
        });
      }
    }
  );

  // List active resources for a workspace
  app.get(
    '/api/workspaces/:id/resources',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const workspace = await prisma.workspace.findFirst({
        where: { id, userId: request.userId },
      });

      if (!workspace) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      const clients = getAwsClients({
        workspaceId: workspace.id,
        roleArn: workspace.roleArn,
        awsAccountId: workspace.awsAccountId,
      });

      const [ec2Instances, ebsVolumes, s3Buckets, rdsInstances] =
        await Promise.all([
          clients.listEC2Instances(),
          clients.listEBSVolumes(),
          clients.listS3Buckets(),
          clients.listRDSInstances(),
        ]);

      return {
        ec2: ec2Instances,
        ebs: ebsVolumes,
        s3: s3Buckets,
        rds: rdsInstances,
        summary: {
          ec2Count: ec2Instances.length,
          ec2Running: ec2Instances.filter((i) => i.state === 'running').length,
          ebsCount: ebsVolumes.length,
          ebsOrphaned: ebsVolumes.filter((v) => v.state === 'available').length,
          s3Count: s3Buckets.length,
          rdsCount: rdsInstances.length,
        },
      };
    }
  );
}
