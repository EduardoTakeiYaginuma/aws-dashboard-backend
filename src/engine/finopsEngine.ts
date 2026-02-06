import prisma from '../db';
import { Prisma } from '@prisma/client';
import {
  AwsClients,
  EC2Instance,
  CloudWatchMetric,
  EBSVolume,
  S3BucketInfo,
  RDSInstance,
  LambdaFunction,
  LoadBalancerInfo,
  NatGatewayInfo,
  ElasticIPInfo,
} from '../aws/types';

export interface RecommendationInput {
  type: string;
  resourceId: string;
  description: string;
  estimatedMonthlySavings: number;
  confidence: 'low' | 'medium' | 'high';
  metadata?: Record<string, unknown>;
}

// ── Pricing references (simplified, USD/month) ──
// These are conservative estimates used for savings calculations.
// Real pricing varies by region, reserved instances, etc.
const EC2_HOURLY_PRICES: Record<string, number> = {
  't3.micro': 0.0104,
  't3.small': 0.0208,
  't3.medium': 0.0416,
  't3.large': 0.0832,
  'm5.large': 0.096,
  'm5.xlarge': 0.192,
  'm5.2xlarge': 0.384,
  'c5.large': 0.085,
  'c5.xlarge': 0.17,
  'c5.2xlarge': 0.34,
  'r5.large': 0.126,
  'r5.xlarge': 0.252,
  'r5.2xlarge': 0.504,
};

const HOURS_IN_MONTH = 730;
// Conservative savings factor: we assume only 60% of the theoretical savings
// to account for burst usage and migration overhead.
const CONSERVATIVE_FACTOR = 0.6;

const EBS_MONTHLY_PER_GIB: Record<string, number> = {
  gp2: 0.10,
  gp3: 0.08,
  io1: 0.125,
  io2: 0.125,
  st1: 0.045,
  sc1: 0.015,
};

// S3 Standard: ~$0.023/GB/month, Glacier: ~$0.004/GB/month
const S3_STANDARD_PER_GB = 0.023;
const S3_GLACIER_PER_GB = 0.004;

const RDS_HOURLY_PRICES: Record<string, number> = {
  'db.t3.micro': 0.017,
  'db.t3.small': 0.034,
  'db.t3.medium': 0.068,
  'db.m5.large': 0.171,
  'db.m5.xlarge': 0.342,
  'db.r5.large': 0.24,
  'db.r5.xlarge': 0.48,
  'db.r5.2xlarge': 0.96,
};

// Lambda pricing (us-east-1)
const LAMBDA_PRICE_PER_GB_SECOND = 0.0000166667;
const LAMBDA_FREE_TIER_GB_SECONDS = 400_000; // free tier per month

// NAT Gateway pricing
const NAT_GATEWAY_HOURLY = 0.045; // ~$32.85/month fixed
const NAT_GATEWAY_PER_GB = 0.045;

// Elastic IP: charged when NOT associated
const ELASTIC_IP_HOURLY_UNUSED = 0.005; // ~$3.65/month

// ELB pricing (ALB/NLB fixed hourly)
const ALB_HOURLY = 0.0225; // ~$16.43/month
const NLB_HOURLY = 0.0225; // ~$16.43/month

// ── Cost Calculation Helpers ──

function getEc2InstanceCost(instance: EC2Instance): number {
  if (instance.state !== 'running') {
    return 0;
  }
  const hourlyPrice = EC2_HOURLY_PRICES[instance.instanceType] ?? 0;
  return hourlyPrice * HOURS_IN_MONTH;
}

function getEbsVolumeCost(volume: EBSVolume): number {
  const pricePerGiB = EBS_MONTHLY_PER_GIB[volume.volumeType] ?? 0.1;
  return volume.size * pricePerGiB;
}

function getS3BucketCost(bucket: S3BucketInfo): number {
  const sizeGB = bucket.sizeBytes / (1024 * 1024 * 1024);
  return sizeGB * S3_STANDARD_PER_GB;
}

function getRdsInstanceCost(instance: RDSInstance): number {
  if (instance.status !== 'available') {
    return 0;
  }
  const hourlyPrice = RDS_HOURLY_PRICES[instance.dbInstanceClass] ?? 0;
  return hourlyPrice * HOURS_IN_MONTH;
}

function getLambdaFunctionCost(fn: LambdaFunction): number {
  if (fn.avgInvocationsPerDay === 0) return 0;
  const dailyGBSeconds = fn.avgInvocationsPerDay * (fn.avgDurationMs / 1000) * (fn.memoryMB / 1024);
  const monthlyGBSeconds = dailyGBSeconds * 30;
  const billableGBSeconds = Math.max(0, monthlyGBSeconds - LAMBDA_FREE_TIER_GB_SECONDS);
  return billableGBSeconds * LAMBDA_PRICE_PER_GB_SECOND;
}

function getLoadBalancerCost(lb: LoadBalancerInfo): number {
  const hourly = lb.type === 'network' ? NLB_HOURLY : ALB_HOURLY;
  return hourly * HOURS_IN_MONTH;
}

function getNatGatewayCost(nat: NatGatewayInfo): number {
  const fixedCost = NAT_GATEWAY_HOURLY * HOURS_IN_MONTH;
  const dailyGB = nat.bytesProcessedPerDay / (1024 * 1024 * 1024);
  const dataTransferCost = dailyGB * 30 * NAT_GATEWAY_PER_GB;
  return fixedCost + dataTransferCost;
}

function getElasticIPCost(eip: ElasticIPInfo): number {
  if (eip.associationId) return 0;
  return ELASTIC_IP_HOURLY_UNUSED * HOURS_IN_MONTH;
}

/**
 * Persist resource information to the database.
 */
async function upsertResources(
  workspaceId: string,
  resources: Prisma.ResourceCreateInput[]
): Promise<void> {
  const now = new Date();
  await prisma.$transaction(
    resources.map((resource) =>
      prisma.resource.upsert({
        where: {
          workspaceId_resourceId: {
            workspaceId,
            resourceId: resource.resourceId,
          },
        },
        create: {
          workspaceId,
          resourceId: resource.resourceId,
          service: resource.service,
          type: resource.type,
          name: resource.name,
          tags: resource.tags,
          state: resource.state,
          estimatedMonthlyCost: resource.estimatedMonthlyCost,
          lastSeenAt: now
        },
        update: {
          service: resource.service,
          type: resource.type,
          name: resource.name,
          tags: resource.tags,
          state: resource.state,
          estimatedMonthlyCost: resource.estimatedMonthlyCost,
          lastSeenAt: now
        },
      })
    )
  );
  console.log(`[engine] Upserted ${resources.length} resources for workspace ${workspaceId}`);
}


/**
 * Heuristic 1: EC2 Downsizing
 *
 * Rule: If average CPU utilization < 10% over 14 days, recommend downsizing.
 * Savings = (current_hourly - next_smaller_hourly) * 730 * 0.6
 *
 * Confidence:
 * - high: avg CPU < 5%
 * - medium: avg CPU 5-10%
 */
export function analyzeEC2Downsizing(
  instances: EC2Instance[],
  metrics: CloudWatchMetric[]
): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];
  const CPU_THRESHOLD = 10;

  const metricsMap = new Map(metrics.map((m) => [m.instanceId, m]));

  for (const instance of instances) {
    if (instance.state !== 'running') continue;

    const metric = metricsMap.get(instance.instanceId);
    if (!metric || metric.periodDays < 14) continue;

    if (metric.averageCpuPercent < CPU_THRESHOLD) {
      const currentPrice = EC2_HOURLY_PRICES[instance.instanceType] ?? 0.192;
      // Estimate savings as ~50% of current cost (downsizing to a smaller tier)
      const savings = currentPrice * HOURS_IN_MONTH * 0.5 * CONSERVATIVE_FACTOR;
      const confidence: 'low' | 'medium' | 'high' =
        metric.averageCpuPercent < 5 ? 'high' : 'medium';

      const name = instance.tags['Name'] || instance.instanceId;
      recommendations.push({
        type: 'EC2_DOWN_SIZE',
        resourceId: instance.instanceId,
        description:
          `Instance "${name}" (${instance.instanceType}) has average CPU utilization of ${metric.averageCpuPercent.toFixed(1)}% ` +
          `over the last ${metric.periodDays} days. Consider downsizing to a smaller instance type or stopping if unused.`,
        estimatedMonthlySavings: Math.round(savings * 100) / 100,
        confidence,
        metadata: {
          instanceType: instance.instanceType,
          averageCpu: metric.averageCpuPercent,
          maxCpu: metric.maxCpuPercent,
          name,
        },
      });
    }
  }

  return recommendations;
}

/**
 * Heuristic 2: EBS Orphaned Volumes
 *
 * Rule: If an EBS volume is in "available" state (not attached) for > 7 days,
 * recommend deletion or snapshot.
 * Savings = volume_size * price_per_gib_month
 * Confidence: high (volume is clearly unused)
 */
export function analyzeEBSOrphaned(volumes: EBSVolume[]): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];
  const ORPHAN_DAYS_THRESHOLD = 7;
  const now = new Date();

  for (const volume of volumes) {
    if (volume.state !== 'available' || volume.attachments.length > 0) continue;

    const daysSinceCreation = Math.floor(
      (now.getTime() - volume.createTime.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceCreation > ORPHAN_DAYS_THRESHOLD) {
      const pricePerGiB = EBS_MONTHLY_PER_GIB[volume.volumeType] ?? 0.10;
      const savings = volume.size * pricePerGiB;

      recommendations.push({
        type: 'EBS_ORPHAN',
        resourceId: volume.volumeId,
        description:
          `EBS volume ${volume.volumeId} (${volume.volumeType}, ${volume.size} GiB) ` +
          `has been detached for ${daysSinceCreation} days. ` +
          `Consider creating a snapshot and deleting the volume to save on storage costs.`,
        estimatedMonthlySavings: Math.round(savings * 100) / 100,
        confidence: 'high',
        metadata: {
          volumeType: volume.volumeType,
          sizeGiB: volume.size,
          daysSinceCreation,
        },
      });
    }
  }

  return recommendations;
}

/**
 * Heuristic 3: S3 Lifecycle Optimization
 *
 * Rule: If objects in a bucket haven't been accessed in > 90 days
 * and are in STANDARD storage, recommend lifecycle policy to move to Glacier.
 * Savings = size_gb * (standard_price - glacier_price) * 0.6
 * Confidence: medium (access patterns may vary)
 */
export function analyzeS3Lifecycle(buckets: S3BucketInfo[]): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];
  const INACTIVITY_DAYS_THRESHOLD = 90;

  for (const bucket of buckets) {
    if (
      bucket.lastAccessedDays > INACTIVITY_DAYS_THRESHOLD &&
      bucket.storageClass === 'STANDARD'
    ) {
      const sizeGB = bucket.sizeBytes / (1024 * 1024 * 1024);
      const savings =
        sizeGB * (S3_STANDARD_PER_GB - S3_GLACIER_PER_GB) * CONSERVATIVE_FACTOR;

      recommendations.push({
        type: 'S3_LIFECYCLE',
        resourceId: bucket.bucketName,
        description:
          `Bucket "${bucket.bucketName}" has ${bucket.objectCount.toLocaleString()} objects ` +
          `(${(sizeGB).toFixed(1)} GB) that haven't been accessed in ${bucket.lastAccessedDays} days. ` +
          `Consider adding a lifecycle policy to transition to Glacier or Glacier Deep Archive.`,
        estimatedMonthlySavings: Math.round(savings * 100) / 100,
        confidence: 'medium',
        metadata: {
          bucketName: bucket.bucketName,
          sizeGB: Math.round(sizeGB * 10) / 10,
          objectCount: bucket.objectCount,
          lastAccessedDays: bucket.lastAccessedDays,
        },
      });
    }
  }

  return recommendations;
}

/**
 * Heuristic 4: RDS Downsizing
 *
 * Rule: If RDS instance average CPU < 15% AND average connections < 10,
 * recommend downsizing.
 * Savings = (current_hourly - next_smaller_hourly) * 730 * 0.6
 * Confidence:
 * - high: CPU < 5% and connections < 3
 * - medium: CPU < 15% and connections < 10
 */
export function analyzeRDSDownsizing(
  instances: RDSInstance[]
): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];
  const CPU_THRESHOLD = 15;
  const CONN_THRESHOLD = 10;

  for (const instance of instances) {
    if (instance.status !== 'available') continue;

    if (
      instance.averageCpuPercent < CPU_THRESHOLD &&
      instance.averageConnections < CONN_THRESHOLD
    ) {
      const currentPrice =
        RDS_HOURLY_PRICES[instance.dbInstanceClass] ?? 0.342;
      // Estimate savings as ~50% of current cost
      const savings = currentPrice * HOURS_IN_MONTH * 0.5 * CONSERVATIVE_FACTOR;
      const confidence: 'low' | 'medium' | 'high' =
        instance.averageCpuPercent < 5 && instance.averageConnections < 3
          ? 'high'
          : 'medium';

      recommendations.push({
        type: 'RDS_DOWN_SIZE',
        resourceId: instance.dbInstanceId,
        description:
          `RDS instance "${instance.dbInstanceId}" (${instance.dbInstanceClass}, ${instance.engine}) ` +
          `has average CPU of ${instance.averageCpuPercent.toFixed(1)}% and ` +
          `${instance.averageConnections} avg connections. ` +
          `Consider downsizing to a smaller instance class${instance.multiAZ ? ' or disabling Multi-AZ if not needed' : ''}.`,
        estimatedMonthlySavings: Math.round(savings * 100) / 100,
        confidence,
        metadata: {
          dbInstanceClass: instance.dbInstanceClass,
          engine: instance.engine,
          averageCpu: instance.averageCpuPercent,
          avgConnections: instance.averageConnections,
          multiAZ: instance.multiAZ,
        },
      });
    }
  }

  return recommendations;
}

/**
 * Heuristic 5: Lambda Optimization
 *
 * Rules:
 * - Zero invocations over 14 days → recommend deletion or disabling
 * - Memory oversized (> 3x what duration suggests) → recommend right-sizing
 * Confidence:
 * - high: zero invocations
 * - medium: oversized memory
 */
export function analyzeLambdaOptimization(
  functions: LambdaFunction[]
): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];

  for (const fn of functions) {
    // Zero invocations
    if (fn.avgInvocationsPerDay === 0) {
      // Estimate what this function would cost if it were invoked at a minimal level,
      // or just report the fixed overhead of keeping it deployed
      const memoryGB = fn.memoryMB / 1024;
      // Use a conservative estimate: if it used to run, savings = what it would cost
      // at a modest invocation rate; if truly unused, the savings is the cleanup value
      const estimatedSavings = memoryGB * fn.timeoutSeconds * 100 * LAMBDA_PRICE_PER_GB_SECOND * 30;

      recommendations.push({
        type: 'LAMBDA_UNUSED',
        resourceId: fn.functionName,
        description:
          `Lambda function "${fn.functionName}" (${fn.runtime}, ${fn.memoryMB}MB) ` +
          `has had zero invocations over the last 14 days. ` +
          `Consider deleting or disabling it to reduce clutter and potential security surface.`,
        estimatedMonthlySavings: Math.round(estimatedSavings * 100) / 100,
        confidence: 'high',
        metadata: {
          functionName: fn.functionName,
          runtime: fn.runtime,
          memoryMB: fn.memoryMB,
          timeoutSeconds: fn.timeoutSeconds,
          lastModified: fn.lastModified,
        },
      });
      continue;
    }

    // Oversized memory: if average duration is very short relative to allocated memory
    // Heuristic: if the function uses < 33% of its allocated memory-seconds capacity
    // (i.e., duration is so short that it could run with 1/3 the memory)
    if (fn.memoryMB >= 512 && fn.avgDurationMs > 0) {
      // Estimate "needed" memory based on duration pattern
      // If avg duration < 100ms and memory >= 512MB, it's likely oversized
      const memoryGB = fn.memoryMB / 1024;
      const rightsizedMemoryMB = Math.max(128, Math.ceil(fn.memoryMB / 3));
      const rightsizedMemoryGB = rightsizedMemoryMB / 1024;

      const currentGBSeconds = fn.avgInvocationsPerDay * (fn.avgDurationMs / 1000) * memoryGB * 30;
      const rightsizedGBSeconds = fn.avgInvocationsPerDay * (fn.avgDurationMs / 1000) * rightsizedMemoryGB * 30;

      if (fn.avgDurationMs < 100 && fn.memoryMB >= 512) {
        const savings = Math.max(0, currentGBSeconds - rightsizedGBSeconds) * LAMBDA_PRICE_PER_GB_SECOND;

        if (savings > 0.5) {
          recommendations.push({
            type: 'LAMBDA_OVERSIZED',
            resourceId: fn.functionName,
            description:
              `Lambda function "${fn.functionName}" (${fn.memoryMB}MB) has an average duration of ` +
              `${fn.avgDurationMs.toFixed(0)}ms. Consider reducing memory to ~${rightsizedMemoryMB}MB ` +
              `to save on compute costs without impacting performance.`,
            estimatedMonthlySavings: Math.round(savings * 100) / 100,
            confidence: 'medium',
            metadata: {
              functionName: fn.functionName,
              currentMemoryMB: fn.memoryMB,
              suggestedMemoryMB: rightsizedMemoryMB,
              avgDurationMs: fn.avgDurationMs,
              avgInvocationsPerDay: fn.avgInvocationsPerDay,
            },
          });
        }
      }
    }
  }

  return recommendations;
}

/**
 * Heuristic 6: Idle Load Balancers
 *
 * Rules:
 * - No registered targets → recommend deletion
 * - Zero requests over 14 days → recommend deletion
 * Confidence:
 * - high: no targets
 * - medium: zero requests (targets may be warming up)
 */
export function analyzeELBIdle(
  loadBalancers: LoadBalancerInfo[]
): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];

  for (const lb of loadBalancers) {
    if (lb.state !== 'active') continue;

    const hourly = lb.type === 'network' ? NLB_HOURLY : ALB_HOURLY;
    const monthlyCost = hourly * HOURS_IN_MONTH;

    if (lb.totalTargetCount === 0) {
      recommendations.push({
        type: 'ELB_NO_TARGETS',
        resourceId: lb.loadBalancerName,
        description:
          `Load balancer "${lb.loadBalancerName}" (${lb.type}) has no registered targets. ` +
          `Consider deleting it to save on fixed hourly charges.`,
        estimatedMonthlySavings: Math.round(monthlyCost * 100) / 100,
        confidence: 'high',
        metadata: {
          loadBalancerName: lb.loadBalancerName,
          type: lb.type,
          createdAt: lb.createdAt.toISOString(),
        },
      });
    } else if (lb.requestCountPerDay === 0) {
      recommendations.push({
        type: 'ELB_NO_TRAFFIC',
        resourceId: lb.loadBalancerName,
        description:
          `Load balancer "${lb.loadBalancerName}" (${lb.type}) has ${lb.totalTargetCount} target(s) ` +
          `but received zero requests over the last 14 days. ` +
          `Consider removing it if the service is no longer in use.`,
        estimatedMonthlySavings: Math.round(monthlyCost * 100) / 100,
        confidence: 'medium',
        metadata: {
          loadBalancerName: lb.loadBalancerName,
          type: lb.type,
          totalTargetCount: lb.totalTargetCount,
          activeTargetCount: lb.activeTargetCount,
        },
      });
    }
  }

  return recommendations;
}

/**
 * Heuristic 7: Unassociated Elastic IPs
 *
 * Rule: Elastic IPs not associated with any instance or ENI are charged $0.005/hour.
 * Savings: ~$3.65/month per unused EIP
 * Confidence: high (clear waste)
 */
export function analyzeElasticIPUnused(
  eips: ElasticIPInfo[]
): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];

  for (const eip of eips) {
    if (!eip.associationId) {
      const savings = ELASTIC_IP_HOURLY_UNUSED * HOURS_IN_MONTH;

      recommendations.push({
        type: 'EIP_UNASSOCIATED',
        resourceId: eip.allocationId,
        description:
          `Elastic IP ${eip.publicIp} (${eip.allocationId}) is not associated with any instance. ` +
          `AWS charges for idle Elastic IPs. Consider releasing it if no longer needed.`,
        estimatedMonthlySavings: Math.round(savings * 100) / 100,
        confidence: 'high',
        metadata: {
          allocationId: eip.allocationId,
          publicIp: eip.publicIp,
          domain: eip.domain,
        },
      });
    }
  }

  return recommendations;
}

/**
 * Heuristic 8: Idle NAT Gateways
 *
 * Rule: NAT Gateway with < 1GB/day of traffic over 14 days.
 * Fixed cost is ~$32.85/month regardless of usage.
 * Savings: fixed cost + minimal data transfer
 * Confidence: medium (sporadic traffic possible)
 */
export function analyzeNatGatewayIdle(
  natGateways: NatGatewayInfo[]
): RecommendationInput[] {
  const recommendations: RecommendationInput[] = [];
  const BYTES_PER_GB = 1024 * 1024 * 1024;
  const TRAFFIC_THRESHOLD_GB_PER_DAY = 1;

  for (const nat of natGateways) {
    if (nat.state !== 'available') continue;

    const dailyGB = nat.bytesProcessedPerDay / BYTES_PER_GB;

    if (dailyGB < TRAFFIC_THRESHOLD_GB_PER_DAY) {
      const fixedCost = NAT_GATEWAY_HOURLY * HOURS_IN_MONTH;
      const dataTransferCost = dailyGB * 30 * NAT_GATEWAY_PER_GB;
      const savings = fixedCost + dataTransferCost;

      recommendations.push({
        type: 'NAT_GW_IDLE',
        resourceId: nat.natGatewayId,
        description:
          `NAT Gateway "${nat.natGatewayId}" processes only ${dailyGB.toFixed(2)} GB/day ` +
          `(< 1 GB/day threshold). The fixed cost is ~$32.85/month regardless of usage. ` +
          `Consider replacing with a NAT instance or VPC endpoints for specific services.`,
        estimatedMonthlySavings: Math.round(savings * 100) / 100,
        confidence: 'medium',
        metadata: {
          natGatewayId: nat.natGatewayId,
          vpcId: nat.vpcId,
          subnetId: nat.subnetId,
          dailyTrafficGB: Math.round(dailyGB * 100) / 100,
        },
      });
    }
  }

  return recommendations;
}

/**
 * Run all heuristics against the data from AWS clients and return
 * a combined list of recommendations.
 */
export async function runFinOpsEngine(
  clients: AwsClients,
  workspaceId: string
): Promise<RecommendationInput[]> {
  const [
    ec2Instances, ebsVolumes, s3Buckets, rdsInstances,
    lambdaFunctions, loadBalancers, natGateways, elasticIPs,
  ] = await Promise.all([
    clients.listEC2Instances(),
    clients.listEBSVolumes(),
    clients.listS3Buckets(),
    clients.listRDSInstances(),
    clients.listLambdaFunctions(),
    clients.listLoadBalancers(),
    clients.listNatGateways(),
    clients.listElasticIPs(),
  ]);

  const instanceIds = ec2Instances.map((i) => i.instanceId);
  const cpuMetrics = await clients.getEC2CpuMetrics(instanceIds);

  const resourcesToUpsert: Prisma.ResourceCreateInput[] = [
    ...ec2Instances.map(
      (r) =>
        ({
          resourceId: r.instanceId,
          service: 'EC2',
          type: r.instanceType,
          name: r.tags['Name'] ?? null,
          tags: r.tags,
          state: r.state,
          estimatedMonthlyCost: getEc2InstanceCost(r),
        } as Prisma.ResourceCreateInput)
    ),
    ...ebsVolumes.map(
      (r) =>
        ({
          resourceId: r.volumeId,
          service: 'EBS',
          type: r.volumeType,
          state: r.state,
          estimatedMonthlyCost: getEbsVolumeCost(r),
        } as Prisma.ResourceCreateInput)
    ),
    ...s3Buckets.map(
      (r) =>
        ({
          resourceId: r.bucketName,
          service: 'S3',
          type: 'bucket',
          name: r.bucketName,
          state: 'available',
          estimatedMonthlyCost: getS3BucketCost(r),
        } as Prisma.ResourceCreateInput)
    ),
    ...rdsInstances.map(
      (r) =>
        ({
          resourceId: r.dbInstanceId,
          service: 'RDS',
          type: r.dbInstanceClass,
          name: r.dbInstanceId,
          state: r.status,
          estimatedMonthlyCost: getRdsInstanceCost(r),
        } as Prisma.ResourceCreateInput)
    ),
    ...lambdaFunctions.map(
      (r) =>
        ({
          resourceId: r.functionName,
          service: 'Lambda',
          type: `${r.runtime} / ${r.memoryMB}MB`,
          name: r.functionName,
          state: r.avgInvocationsPerDay > 0 ? 'active' : 'inactive',
          estimatedMonthlyCost: getLambdaFunctionCost(r),
        } as Prisma.ResourceCreateInput)
    ),
    ...loadBalancers.map(
      (r) =>
        ({
          resourceId: r.loadBalancerName,
          service: 'ELB',
          type: r.type,
          name: r.loadBalancerName,
          state: r.state,
          estimatedMonthlyCost: getLoadBalancerCost(r),
        } as Prisma.ResourceCreateInput)
    ),
    ...natGateways.map(
      (r) =>
        ({
          resourceId: r.natGatewayId,
          service: 'VPC',
          type: 'NATGateway',
          name: r.natGatewayId,
          state: r.state,
          estimatedMonthlyCost: getNatGatewayCost(r),
        } as Prisma.ResourceCreateInput)
    ),
    ...elasticIPs.map(
      (r) =>
        ({
          resourceId: r.allocationId,
          service: 'VPC',
          type: 'ElasticIP',
          name: r.publicIp,
          state: r.associationId ? 'associated' : 'unassociated',
          estimatedMonthlyCost: getElasticIPCost(r),
        } as Prisma.ResourceCreateInput)
    ),
  ];

  await upsertResources(workspaceId, resourcesToUpsert);

  const recommendations: RecommendationInput[] = [
    ...analyzeEC2Downsizing(ec2Instances, cpuMetrics),
    ...analyzeEBSOrphaned(ebsVolumes),
    ...analyzeS3Lifecycle(s3Buckets),
    ...analyzeRDSDownsizing(rdsInstances),
    ...analyzeLambdaOptimization(lambdaFunctions),
    ...analyzeELBIdle(loadBalancers),
    ...analyzeElasticIPUnused(elasticIPs),
    ...analyzeNatGatewayIdle(natGateways),
  ];

  return recommendations;
}
