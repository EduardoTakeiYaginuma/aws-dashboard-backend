export interface EC2Instance {
  instanceId: string;
  instanceType: string;
  state: string;
  launchTime: Date;
  tags: Record<string, string>;
  platform: string;
}

export interface CloudWatchMetric {
  instanceId: string;
  averageCpuPercent: number;
  maxCpuPercent: number;
  periodDays: number;
}

export interface EBSVolume {
  volumeId: string;
  size: number; // GiB
  volumeType: string;
  state: string;
  attachments: { instanceId: string; state: string }[];
  createTime: Date;
}

export interface S3BucketInfo {
  bucketName: string;
  region: string;
  sizeBytes: number;
  objectCount: number;
  lastAccessedDays: number;
  storageClass: string;
}

export interface RDSInstance {
  dbInstanceId: string;
  dbInstanceClass: string;
  engine: string;
  status: string;
  allocatedStorage: number; // GiB
  averageCpuPercent: number;
  averageConnections: number;
  multiAZ: boolean;
}

export interface CostData {
  totalMonthly: number;
  byService: Record<string, number>;
  currency: string;
}

export interface LambdaFunction {
  functionName: string;
  runtime: string;
  memoryMB: number;
  timeoutSeconds: number;
  codeSize: number;
  lastModified: string;
  avgInvocationsPerDay: number;
  avgDurationMs: number;
}

export interface LoadBalancerInfo {
  loadBalancerArn: string;
  loadBalancerName: string;
  type: string;
  state: string;
  createdAt: Date;
  activeTargetCount: number;
  totalTargetCount: number;
  requestCountPerDay: number;
}

export interface NatGatewayInfo {
  natGatewayId: string;
  state: string;
  subnetId: string;
  vpcId: string;
  createdAt: Date;
  bytesProcessedPerDay: number;
}

export interface ElasticIPInfo {
  allocationId: string;
  publicIp: string;
  associationId?: string;
  instanceId?: string;
  domain: string;
}

export interface AwsClients {
  listEC2Instances(): Promise<EC2Instance[]>;
  getEC2CpuMetrics(instanceIds: string[]): Promise<CloudWatchMetric[]>;
  listEBSVolumes(): Promise<EBSVolume[]>;
  listS3Buckets(): Promise<S3BucketInfo[]>;
  listRDSInstances(): Promise<RDSInstance[]>;
  listLambdaFunctions(): Promise<LambdaFunction[]>;
  listLoadBalancers(): Promise<LoadBalancerInfo[]>;
  listNatGateways(): Promise<NatGatewayInfo[]>;
  listElasticIPs(): Promise<ElasticIPInfo[]>;
  getCostData(): Promise<CostData>;
  testConnection(): Promise<boolean>;
}
