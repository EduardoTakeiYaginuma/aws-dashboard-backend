import {
  AwsClients,
  EC2Instance,
  CloudWatchMetric,
  EBSVolume,
  S3BucketInfo,
  RDSInstance,
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
 * Run all heuristics against the data from AWS clients and return
 * a combined list of recommendations.
 */
export async function runFinOpsEngine(
  clients: AwsClients
): Promise<RecommendationInput[]> {
  const [ec2Instances, ebsVolumes, s3Buckets, rdsInstances] = await Promise.all([
    clients.listEC2Instances(),
    clients.listEBSVolumes(),
    clients.listS3Buckets(),
    clients.listRDSInstances(),
  ]);

  const instanceIds = ec2Instances.map((i) => i.instanceId);
  const cpuMetrics = await clients.getEC2CpuMetrics(instanceIds);

  const recommendations: RecommendationInput[] = [
    ...analyzeEC2Downsizing(ec2Instances, cpuMetrics),
    ...analyzeEBSOrphaned(ebsVolumes),
    ...analyzeS3Lifecycle(s3Buckets),
    ...analyzeRDSDownsizing(rdsInstances),
  ];

  return recommendations;
}
