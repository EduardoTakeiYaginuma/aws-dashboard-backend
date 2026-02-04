import {
  AwsClients,
  EC2Instance,
  CloudWatchMetric,
  EBSVolume,
  S3BucketInfo,
  RDSInstance,
  CostData,
  LambdaFunction,
  LoadBalancerInfo,
  NatGatewayInfo,
  ElasticIPInfo,
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

  const lambdaFunctions: LambdaFunction[] = [
    {
      functionName: 'api-gateway-handler',
      runtime: 'nodejs18.x',
      memoryMB: 256,
      timeoutSeconds: 30,
      codeSize: 5_242_880,
      lastModified: '2024-07-15T10:00:00Z',
      avgInvocationsPerDay: 12_500,
      avgDurationMs: 45,
    },
    {
      functionName: 'legacy-image-resizer',
      runtime: 'python3.9',
      memoryMB: 1024,
      timeoutSeconds: 300,
      codeSize: 15_728_640,
      lastModified: '2023-11-01T08:00:00Z',
      avgInvocationsPerDay: 0, // zero invocations — candidate
      avgDurationMs: 0,
    },
    {
      functionName: 'old-etl-processor',
      runtime: 'python3.8',
      memoryMB: 2048,
      timeoutSeconds: 900,
      codeSize: 52_428_800,
      lastModified: '2023-06-20T12:00:00Z',
      avgInvocationsPerDay: 0, // zero invocations — candidate
      avgDurationMs: 0,
    },
    {
      functionName: 'notification-sender',
      runtime: 'nodejs18.x',
      memoryMB: 512,
      timeoutSeconds: 60,
      codeSize: 2_097_152,
      lastModified: '2024-08-01T14:00:00Z',
      avgInvocationsPerDay: 3_200,
      avgDurationMs: 12,  // very low duration vs 512MB — oversized memory
    },
    {
      functionName: 'data-aggregator',
      runtime: 'nodejs20.x',
      memoryMB: 128,
      timeoutSeconds: 15,
      codeSize: 1_048_576,
      lastModified: '2024-09-10T09:00:00Z',
      avgInvocationsPerDay: 8_000,
      avgDurationMs: 85,
    },
  ];

  const loadBalancers: LoadBalancerInfo[] = [
    {
      loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/50dc6c495c0c9188',
      loadBalancerName: 'prod-alb',
      type: 'application',
      state: 'active',
      createdAt: new Date('2024-03-01'),
      activeTargetCount: 4,
      totalTargetCount: 4,
      requestCountPerDay: 250_000,
    },
    {
      loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/staging-alb/60dc6c495c0c9199',
      loadBalancerName: 'staging-alb',
      type: 'application',
      state: 'active',
      createdAt: new Date('2024-04-15'),
      activeTargetCount: 0, // no healthy targets — candidate
      totalTargetCount: 0,
      requestCountPerDay: 0,
    },
    {
      loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/internal-nlb/70dc6c495c0c9200',
      loadBalancerName: 'internal-nlb',
      type: 'network',
      state: 'active',
      createdAt: new Date('2024-01-10'),
      activeTargetCount: 2,
      totalTargetCount: 2,
      requestCountPerDay: 0, // zero requests — candidate
    },
  ];

  const natGateways: NatGatewayInfo[] = [
    {
      natGatewayId: 'nat-0a1b2c3d4e5f00001',
      state: 'available',
      subnetId: 'subnet-abc123',
      vpcId: 'vpc-main001',
      createdAt: new Date('2024-02-01'),
      bytesProcessedPerDay: 85_000_000_000, // ~85 GB/day — active
    },
    {
      natGatewayId: 'nat-0a1b2c3d4e5f00002',
      state: 'available',
      subnetId: 'subnet-def456',
      vpcId: 'vpc-dev001',
      createdAt: new Date('2024-05-01'),
      bytesProcessedPerDay: 50_000_000, // ~50 MB/day — idle candidate
    },
  ];

  const elasticIPs: ElasticIPInfo[] = [
    {
      allocationId: 'eipalloc-0a1b2c3d4e5f00001',
      publicIp: '54.123.45.67',
      associationId: 'eipassoc-abc123',
      instanceId: 'i-0a1b2c3d4e5f00001',
      domain: 'vpc',
    },
    {
      allocationId: 'eipalloc-0a1b2c3d4e5f00002',
      publicIp: '54.123.45.68',
      domain: 'vpc',
      // not associated — candidate
    },
    {
      allocationId: 'eipalloc-0a1b2c3d4e5f00003',
      publicIp: '54.123.45.69',
      domain: 'vpc',
      // not associated — candidate
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

    async listLambdaFunctions(): Promise<LambdaFunction[]> {
      return lambdaFunctions;
    },

    async listLoadBalancers(): Promise<LoadBalancerInfo[]> {
      return loadBalancers;
    },

    async listNatGateways(): Promise<NatGatewayInfo[]> {
      return natGateways;
    },

    async listElasticIPs(): Promise<ElasticIPInfo[]> {
      return elasticIPs;
    },

    async getCostData(): Promise<CostData> {
      return costData;
    },

    async testConnection(): Promise<boolean> {
      return true;
    },
  };
}
