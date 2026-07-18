const requiredSecretName = 'BACKUP_SIGNING_PRIVATE_KEY'

function configuredValue(configuration, pattern, label) {
  const match = configuration.match(pattern)
  if (!match?.[1]) throw new Error(`${label}がwrangler.worker.jsoncに設定されていません`)
  return match[1]
}

function dotenvValue(source, name) {
  const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)${escapedName}=["']?([^\\n"']+)["']?(?:\\n|$)`, 'u'))
  return match?.[1]
}

export function readDeploymentSettings(configuration, devVars) {
  const databaseId = configuredValue(configuration, /"database_id"\s*:\s*"([^"]+)"/u, 'D1 database_id')
  const databaseName = configuredValue(configuration, /"database_name"\s*:\s*"([^"]+)"/u, 'D1 database_name')
  if (databaseId === '00000000-0000-0000-0000-000000000000') {
    throw new Error('D1 database_idが初期値のままです')
  }
  if (!configuration.includes(`"${requiredSecretName}"`)) {
    throw new Error(`${requiredSecretName}が必須Secretとして宣言されていません`)
  }
  const signingPrivateKey = dotenvValue(devVars, requiredSecretName)
  if (!signingPrivateKey || Buffer.from(signingPrivateKey, 'base64url').byteLength < 32) {
    throw new Error(`.dev.varsの${requiredSecretName}が未設定または不正です`)
  }
  return { databaseId, databaseName, signingPrivateKey }
}

export function hasNoPendingMigrations(output) {
  return /No migrations to apply/iu.test(output)
}
