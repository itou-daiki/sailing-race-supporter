import { describe, expect, it } from 'vitest'
import { hasNoPendingMigrations, readDeploymentSettings } from '../scripts/deploy-worker-settings.mjs'

const configuration = `{
  "secrets": { "required": ["BACKUP_SIGNING_PRIVATE_KEY"] },
  "d1_databases": [{
    "database_name": "sailing-race-supporter",
    "database_id": "20c2f73c-06d5-460c-a3e8-74d888585975"
  }],
  "r2_buckets": [{
    "binding": "BACKUP_ARCHIVES",
    "bucket_name": "sailing-race-supporter-backups"
  }]
}`

describe('Cloudflare production deployment preflight', () => {
  it('loads only the declared D1, R2 and signing-secret settings', () => {
    const settings = readDeploymentSettings(
      configuration,
      'BACKUP_SIGNING_PRIVATE_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"\nUNRELATED_SECRET="do-not-upload"\n',
    )
    expect(settings).toEqual({
      databaseId: '20c2f73c-06d5-460c-a3e8-74d888585975',
      databaseName: 'sailing-race-supporter',
      bucketName: 'sailing-race-supporter-backups',
      signingPrivateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(settings).not.toHaveProperty('UNRELATED_SECRET')
  })

  it('rejects placeholder resources and missing signing secrets before deployment', () => {
    expect(() => readDeploymentSettings(
      configuration.replace('20c2f73c-06d5-460c-a3e8-74d888585975', '00000000-0000-0000-0000-000000000000'),
      'BACKUP_SIGNING_PRIVATE_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"\n',
    )).toThrow('初期値')
    expect(() => readDeploymentSettings(configuration, '')).toThrow('未設定または不正')
  })

  it('requires Wrangler to prove that no remote D1 migrations remain', () => {
    expect(hasNoPendingMigrations('✅ No migrations to apply!')).toBe(true)
    expect(hasNoPendingMigrations('0007_new_table.sql')).toBe(false)
  })
})
