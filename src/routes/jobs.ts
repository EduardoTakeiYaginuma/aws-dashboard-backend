import { FastifyInstance } from 'fastify';
import prisma from '../db';
import { authMiddleware } from '../middleware/auth';

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/jobs',
    { preHandler: authMiddleware },
    async (request, _reply) => {
      const jobs = await prisma.jobRun.findMany({
        include: {
          workspace: {
            select: { id: true, name: true, userId: true },
          },
        },
        orderBy: { startedAt: 'desc' },
        take: 50,
      });

      // Filter to only show jobs for the user's workspaces
      const filtered = jobs.filter(
        (j) => j.workspace.userId === request.userId
      );

      return filtered;
    }
  );
}
