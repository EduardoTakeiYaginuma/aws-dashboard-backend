import { FastifyInstance } from 'fastify';
import prisma from '../db';

interface TrackEventBody {
  visitorId: string;
  event: string;
  metadata?: Record<string, unknown>;
  referrer?: string;
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/analytics - Registrar evento (público, sem auth)
  app.post<{ Body: TrackEventBody }>('/api/analytics', async (request, reply) => {
    const { visitorId, event, metadata, referrer } = request.body;

    if (!visitorId || !event) {
      return reply.status(400).send({ error: 'visitorId and event are required' });
    }

    const userAgent = request.headers['user-agent'] || null;

    try {
      await prisma.analytics.create({
        data: {
          visitorId,
          event,
          metadata: metadata || null,
          userAgent,
          referrer: referrer || null,
        },
      });

      return { success: true };
    } catch (error) {
      console.error('Analytics error:', error);
      return reply.status(500).send({ error: 'Failed to track event' });
    }
  });

  // GET /api/analytics/stats - Dashboard de métricas (com auth simples)
  app.get('/api/analytics/stats', async (request, reply) => {
    // Auth simples para admin
    const authHeader = request.headers.authorization;
    if (!authHeader || authHeader !== 'Bearer dev-token') {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      // Total de visitantes únicos
      const uniqueVisitors = await prisma.analytics.groupBy({
        by: ['visitorId'],
      });

      // Eventos por tipo
      const eventCounts = await prisma.analytics.groupBy({
        by: ['event'],
        _count: { event: true },
        orderBy: { _count: { event: 'desc' } },
      });

      // Eventos das últimas 24h
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const eventsLast24h = await prisma.analytics.count({
        where: { createdAt: { gte: last24h } },
      });

      // Últimos 7 dias por dia
      const last7days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recentEvents = await prisma.analytics.findMany({
        where: { createdAt: { gte: last7days } },
        select: { event: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      // Agrupar por dia
      const eventsByDay: Record<string, number> = {};
      recentEvents.forEach((e) => {
        const day = e.createdAt.toISOString().split('T')[0];
        eventsByDay[day] = (eventsByDay[day] || 0) + 1;
      });

      // Funil de conversão
      const funnel = {
        page_view: 0,
        click_free_test: 0,
        view_instructions: 0,
        click_connect: 0,
        connect_success: 0,
        connect_error: 0,
      };

      eventCounts.forEach((e) => {
        if (e.event in funnel) {
          funnel[e.event as keyof typeof funnel] = e._count.event;
        }
      });

      return {
        summary: {
          uniqueVisitors: uniqueVisitors.length,
          totalEvents: eventCounts.reduce((sum, e) => sum + e._count.event, 0),
          eventsLast24h,
        },
        funnel,
        eventsByDay,
        eventCounts: eventCounts.map((e) => ({
          event: e.event,
          count: e._count.event,
        })),
      };
    } catch (error) {
      console.error('Analytics stats error:', error);
      return reply.status(500).send({ error: 'Failed to get stats' });
    }
  });
}
