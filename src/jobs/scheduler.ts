import cron from 'node-cron';
import prisma from '../db';
import { getAwsClients } from '../aws';
import { runFinOpsEngine } from '../engine/finopsEngine';
import { syncWorkspaceResources } from '../services/resourceSync';

let isRunning = false;

/**
 * Process a single workspace: collect data, run engine, persist recommendations.
 */
async function processWorkspace(workspaceId: string): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });

  if (!workspace) {
    console.warn(`[scheduler] Workspace ${workspaceId} not found, skipping`);
    return;
  }

  const jobRun = await prisma.jobRun.create({
    data: {
      workspaceId: workspace.id,
      status: 'running',
    },
  });

  console.log(
    `[scheduler] Starting job ${jobRun.id} for workspace "${workspace.name}" (${workspace.id})`
  );

  try {
    // Sync all resources into the Resource table
    try {
      const syncResult = await syncWorkspaceResources(workspace.id);
      console.log(`[scheduler] Resource sync: ${syncResult.total} resources synced`);
      if (syncResult.errors.length > 0) {
        console.warn(`[scheduler] Resource sync warnings:`, syncResult.errors);
      }
    } catch (syncErr) {
      console.warn(`[scheduler] Resource sync failed (continuing with recommendations):`, syncErr);
    }

    const clients = getAwsClients({
      workspaceId: workspace.id,
      roleArn: workspace.roleArn,
      awsAccountId: workspace.awsAccountId,
    });

    const recommendations = await runFinOpsEngine(clients, workspace.id);

    let upsertCount = 0;
    for (const rec of recommendations) {
      await prisma.recommendation.upsert({
        where: {
          workspaceId_resourceId_type: {
            workspaceId: workspace.id,
            resourceId: rec.resourceId,
            type: rec.type,
          },
        },
        create: {
          workspaceId: workspace.id,
          type: rec.type,
          resourceId: rec.resourceId,
          description: rec.description,
          estimatedMonthlySavings: rec.estimatedMonthlySavings,
          confidence: rec.confidence,
          status: 'new',
          metadata: (rec.metadata as Record<string, string>) ?? undefined,
        },
        update: {
          description: rec.description,
          estimatedMonthlySavings: rec.estimatedMonthlySavings,
          confidence: rec.confidence,
          metadata: (rec.metadata as Record<string, string>) ?? undefined,
          // Do not overwrite status if user has already acknowledged/dismissed
        },
      });
      upsertCount++;
    }

    // Update workspace status to connected on successful scan
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: 'connected' },
    });

    await prisma.jobRun.update({
      where: { id: jobRun.id },
      data: {
        status: 'completed',
        recommendationsFound: upsertCount,
        completedAt: new Date(),
      },
    });

    console.log(
      `[scheduler] Job ${jobRun.id} completed: ${upsertCount} recommendations for workspace "${workspace.name}"`
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `[scheduler] Job ${jobRun.id} failed for workspace "${workspace.name}":`,
      errorMessage
    );

    await prisma.jobRun.update({
      where: { id: jobRun.id },
      data: {
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
      },
    });
  }
}

/**
 * Main scheduler tick: processes all workspaces sequentially.
 */
async function runSchedulerTick(): Promise<void> {
  if (isRunning) {
    console.log('[scheduler] Previous run still in progress, skipping');
    return;
  }

  isRunning = true;
  console.log(`[scheduler] Starting scheduled run at ${new Date().toISOString()}`);

  try {
    const workspaces = await prisma.workspace.findMany();

    if (workspaces.length === 0) {
      console.log('[scheduler] No workspaces found, nothing to process');
      return;
    }

    console.log(`[scheduler] Processing ${workspaces.length} workspace(s)`);

    for (const workspace of workspaces) {
      await processWorkspace(workspace.id);
    }

    console.log('[scheduler] Scheduled run completed');
  } catch (error) {
    console.error('[scheduler] Scheduler tick error:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the cron scheduler.
 * Default: every 1 minute (JOB_CRON env var).
 */
export function startScheduler(): void {
  const cronExpression = process.env.JOB_CRON || '*/1 * * * *';

  console.log(`[scheduler] Starting with cron expression: ${cronExpression}`);

  cron.schedule(cronExpression, () => {
    runSchedulerTick().catch((err) =>
      console.error('[scheduler] Unhandled error:', err)
    );
  });

  // Also run immediately on startup after a short delay
  setTimeout(() => {
    console.log('[scheduler] Running initial scan...');
    runSchedulerTick().catch((err) =>
      console.error('[scheduler] Initial run error:', err)
    );
  }, 5000);
}
