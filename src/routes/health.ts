import { FastifyInstance } from 'fastify';
import prisma from '../db';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_request, _reply) => {
    let dbStatus = 'ok';
    let lastJobRun = null;

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    try {
      lastJobRun = await prisma.jobRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          recommendationsFound: true,
        },
      });
    } catch {
      // ignore
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      lastJobRun,
    };
  });
}
