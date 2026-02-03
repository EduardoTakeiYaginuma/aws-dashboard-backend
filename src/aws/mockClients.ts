import {
  AwsClients,
  EC2Instance,
  CloudWatchMetric,
  EBSVolume,
  S3BucketInfo,
  RDSInstance,
  CostData,
} from './types';

/**
 * Seeded pseudo-random number generator for deterministic mock data.
 * Uses a simple linear congruential generator (LCG).
 */
function createSeededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff;
  };
}

export function createMockAwsClients(_workspaceId: string): AwsClients {
  const rand = createSeededRandom(42);

  const ec2Instances: EC2Instance[] = [
    {
      instanceId: 'i-0a1b2c3d4e5f00001',
      instanceType: 'm5.xlarge',
      state: 'running',
      launchTime: new Date('2024-06-01'),
      tags: { Name: 'web-server-1', Environment: 'production' },
      platform: 'linux',
    },
    {
      instanceId: 'i-0a1b2c3d4e5f00002',
      instanceType: 'c5.2xlarge',
      state: 'running',
      launchTime: new Date('2024-05-15'),
      tags: { Name: 'worker-1', Environment: 'production' },
      platform: 'linux',
    },
    {
      instanceId: 'i-0a1b2c3d4e5f00003',
      instanceType: 'r5.large',
      state: 'running',
      launchTime: new Date('2024-07-01'),
      tags: { Name: 'db-cache', Environment: 'staging' },
      platform: 'linux',
    },
    {
      instanceId: 'i-0a1b2c3d4e5f00004',
      instanceType: 't3.medium',
      state: 'running',
      launchTime: new Date('2024-08-01'),
      tags: { Name: 'test-server', Environment: 'dev' },
      platform: 'linux',
    },
    {
      instanceId: 'i-0a1b2c3d4e5f00005',
      instanceType: 'm5.2xlarge',
      state: 'running',
      launchTime: new Date('2024-04-01'),
      tags: { Name: 'analytics-1', Environment: 'production' },
      platform: 'linux',
    },
  ];

  // CPU metrics: instances 1,3,4 have low CPU (candidates for downsizing)
  const cpuMetrics: CloudWatchMetric[] = [
    { instanceId: 'i-0a1b2c3d4e5f00001', averageCpuPercent: 5.2, maxCpuPercent: 18, periodDays: 14 },
    { instanceId: 'i-0a1b2c3d4e5f00002', averageCpuPercent: 62.1, maxCpuPercent: 89, periodDays: 14 },
    { instanceId: 'i-0a1b2c3d4e5f00003', averageCpuPercent: 3.8, maxCpuPercent: 12, periodDays: 14 },
    { instanceId: 'i-0a1b2c3d4e5f00004', averageCpuPercent: 7.1, maxCpuPercent: 15, periodDays: 14 },
    { instanceId: 'i-0a1b2c3d4e5f00005', averageCpuPercent: 45.3, maxCpuPercent: 72, periodDays: 14 },
  ];

  const ebsVolumes: EBSVolume[] = [
    {
      volumeId: 'vol-0a1b2c3d4e5f00001',
      size: 100,
      volumeType: 'gp3',
      state: 'in-use',
      attachments: [{ instanceId: 'i-0a1b2c3d4e5f00001', state: 'attached' }],
      createTime: new Date('2024-06-01'),
    },
    {
      volumeId: 'vol-0a1b2c3d4e5f00002',
      size: 500,
      volumeType: 'gp2',
      state: 'available', // orphaned
      attachments: [],
      createTime: new Date('2024-03-15'),
    },
    {
      volumeId: 'vol-0a1b2c3d4e5f00003',
      size: 200,
      volumeType: 'io1',
      state: 'available', // orphaned
      attachments: [],
      createTime: new Date('2024-01-10'),
    },
    {
      volumeId: 'vol-0a1b2c3d4e5f00004',
      size: 50,
      volumeType: 'gp3',
      state: 'in-use',
      attachments: [{ instanceId: 'i-0a1b2c3d4e5f00002', state: 'attached' }],
      createTime: new Date('2024-05-15'),
    },
  ];

  const s3Buckets: S3BucketInfo[] = [
    {
      bucketName: 'company-logs-archive',
      region: 'us-east-1',
      sizeBytes: 1_200_000_000_000, // ~1.2 TB
      objectCount: 5_000_000,
      lastAccessedDays: 120,
      storageClass: 'STANDARD',
    },
    {
      bucketName: 'company-backups-2023',
      region: 'us-east-1',
      sizeBytes: 800_000_000_000, // ~800 GB
      objectCount: 2_000_000,
      lastAccessedDays: 200,
      storageClass: 'STANDARD',
    },
    {
      bucketName: 'company-assets-cdn',
      region: 'us-east-1',
      sizeBytes: 50_000_000_000, // ~50 GB
      objectCount: 100_000,
      lastAccessedDays: 2,
      storageClass: 'STANDARD',
    },
    {
      bucketName: 'company-data-lake',
      region: 'us-east-1',
      sizeBytes: 3_000_000_000_000, // ~3 TB
      objectCount: 10_000_000,
      lastAccessedDays: 95,
      storageClass: 'STANDARD',
    },
  ];

  const rdsInstances: RDSInstance[] = [
    {
      dbInstanceId: 'prod-db-main',
      dbInstanceClass: 'db.r5.2xlarge',
      engine: 'postgres',
      status: 'available',
      allocatedStorage: 500,
      averageCpuPercent: 55.2,
      averageConnections: 120,
      multiAZ: true,
    },
    {
      dbInstanceId: 'staging-db',
      dbInstanceClass: 'db.r5.xlarge',
      engine: 'postgres',
      status: 'available',
      allocatedStorage: 200,
      averageCpuPercent: 8.3,
      averageConnections: 5,
      multiAZ: true,
    },
    {
      dbInstanceId: 'dev-db',
      dbInstanceClass: 'db.m5.large',
      engine: 'mysql',
      status: 'available',
      allocatedStorage: 100,
      averageCpuPercent: 4.1,
      averageConnections: 2,
      multiAZ: false,
    },
  ];

  const costData: CostData = {
    totalMonthly: 12_450.0 + rand() * 500,
    byService: {
      'Amazon EC2': 5_200.0,
      'Amazon RDS': 3_800.0,
      'Amazon S3': 1_500.0,
      'Amazon EBS': 850.0,
      'AWS Lambda': 320.0,
      'Amazon CloudFront': 280.0,
      Other: 500.0,
    },
    currency: 'USD',
  };

  return {
    async listEC2Instances(): Promise<EC2Instance[]> {
      return ec2Instances;
    },

    async getEC2CpuMetrics(instanceIds: string[]): Promise<CloudWatchMetric[]> {
      return cpuMetrics.filter((m) => instanceIds.includes(m.instanceId));
    },

    async listEBSVolumes(): Promise<EBSVolume[]> {
      return ebsVolumes;
    },

    async listS3Buckets(): Promise<S3BucketInfo[]> {
      return s3Buckets;
    },

    async listRDSInstances(): Promise<RDSInstance[]> {
      return rdsInstances;
    },

    async getCostData(): Promise<CostData> {
      return costData;
    },

    async testConnection(): Promise<boolean> {
      return true;
    },
  };
}
