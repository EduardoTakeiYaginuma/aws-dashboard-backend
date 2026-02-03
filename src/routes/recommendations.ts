import { FastifyInstance } from 'fastify';
import prisma from '../db';
import { authMiddleware } from '../middleware/auth';

export async function recommendationRoutes(app: FastifyInstance): Promise<void> {
  // Get recommendation details
  app.get(
    '/api/recommendations/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const recommendation = await prisma.recommendation.findUnique({
        where: { id },
        include: {
          workspace: {
            select: { id: true, name: true, userId: true },
          },
        },
      });

      if (!recommendation) {
        return reply.status(404).send({ error: 'Recommendation not found' });
      }

      if (recommendation.workspace.userId !== request.userId) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      return recommendation;
    }
  );

  // Update recommendation status (acknowledge / dismiss)
  app.patch(
    '/api/recommendations/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.body as { status: string };

      if (!['new', 'acknowledged', 'dismissed'].includes(status)) {
        return reply.status(400).send({
          error: 'Invalid status. Must be one of: new, acknowledged, dismissed',
        });
      }

      const recommendation = await prisma.recommendation.findUnique({
        where: { id },
        include: {
          workspace: {
            select: { userId: true },
          },
        },
      });

      if (!recommendation) {
        return reply.status(404).send({ error: 'Recommendation not found' });
      }

      if (recommendation.workspace.userId !== request.userId) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const updated = await prisma.recommendation.update({
        where: { id },
        data: { status },
      });

      return updated;
    }
  );
}
