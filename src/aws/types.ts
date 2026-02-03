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

export interface AwsClients {
  listEC2Instances(): Promise<EC2Instance[]>;
  getEC2CpuMetrics(instanceIds: string[]): Promise<CloudWatchMetric[]>;
  listEBSVolumes(): Promise<EBSVolume[]>;
  listS3Buckets(): Promise<S3BucketInfo[]>;
  listRDSInstances(): Promise<RDSInstance[]>;
  getCostData(): Promise<CostData>;
  testConnection(): Promise<boolean>;
}
