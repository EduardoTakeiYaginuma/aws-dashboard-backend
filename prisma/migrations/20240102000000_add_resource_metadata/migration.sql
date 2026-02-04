-- CreateTable (if not exists)
CREATE TABLE IF NOT EXISTS "Resource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "arn" TEXT,
    "service" TEXT NOT NULL,
    "type" TEXT,
    "name" TEXT,
    "tags" JSONB,
    "metadata" JSONB,
    "state" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estimatedMonthlyCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- Add metadata column if table already exists but column doesn't
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Resource' AND column_name = 'metadata'
    ) THEN
        ALTER TABLE "Resource" ADD COLUMN "metadata" JSONB;
    END IF;
END $$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Resource_workspaceId_idx" ON "Resource"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Resource_service_idx" ON "Resource"("service");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Resource_workspaceId_resourceId_key" ON "Resource"("workspaceId", "resourceId");

-- AddForeignKey (only if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'Resource_workspaceId_fkey'
    ) THEN
        ALTER TABLE "Resource" ADD CONSTRAINT "Resource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
