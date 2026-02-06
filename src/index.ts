import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health';
import { workspaceRoutes } from './routes/workspaces';
import { recommendationRoutes } from './routes/recommendations';
import { jobRoutes } from './routes/jobs';
import { inventoryRoutes } from './routes/inventory';
import { costsRoutes } from './routes/costs';
import { analyticsRoutes } from './routes/analytics';
import { startScheduler } from './jobs/scheduler';

async function main(): Promise<void> {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(workspaceRoutes);
  await app.register(recommendationRoutes);
  await app.register(jobRoutes);
  await app.register(inventoryRoutes);
  await app.register(costsRoutes);
  await app.register(analyticsRoutes);

  const port = parseInt(process.env.PORT || '4000', 10);
  const host = '0.0.0.0';

  try {
    await app.listen({ port, host });
    console.log(`[server] Backend running on http://${host}:${port}`);
    console.log(`[server] AWS_MOCK=${process.env.AWS_MOCK ?? 'not set'}`);

    // Start the scheduler
    startScheduler();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
