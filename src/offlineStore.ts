export interface QueuedOperation {
  id: string
  eventId: string
  raceId?: string
  type: string
  payload: unknown
  clientTime: string
  queuedAt: string
}

export interface CachedEventState<T = unknown> {
  eventId: string
  sequence: number
  savedAt: string
  value: T
}

export interface LocalMemberProfile {
  eventId: string
  memberId: string
  displayName: string
  assignment: string
  role: string
  recoveryHint?: string
  savedAt: string
}

const DATABASE_NAME = 'sailing-race-supporter'
const DATABASE_VERSION = 1
const OUTBOX = 'outbox'
const SNAPSHOTS = 'snapshots'
const PROFILES = 'profiles'

let databasePromise: Promise<IDBDatabase> | undefined
let databaseInstance: IDBDatabase | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      if (!database.objectStoreNames.contains(OUTBOX)) {
        const outbox = database.createObjectStore(OUTBOX, { keyPath: 'id' })
        outbox.createIndex('eventId', 'eventId')
        outbox.createIndex('queuedAt', 'queuedAt')
      }
      if (!database.objectStoreNames.contains(SNAPSHOTS)) {
        database.createObjectStore(SNAPSHOTS, { keyPath: 'eventId' })
      }
      if (!database.objectStoreNames.contains(PROFILES)) {
        database.createObjectStore(PROFILES, { keyPath: 'eventId' })
      }
    })
    request.addEventListener('success', () => {
      databaseInstance = request.result
      resolve(request.result)
    })
    request.addEventListener('error', () => reject(request.error))
  })

  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, mode)
  return requestResult(operation(transaction.objectStore(storeName)))
}

export async function queueOperation(operation: QueuedOperation): Promise<void> {
  await withStore(OUTBOX, 'readwrite', (store) => store.put(operation))
}

export async function listQueuedOperations(eventId: string): Promise<QueuedOperation[]> {
  const database = await openDatabase()
  const transaction = database.transaction(OUTBOX, 'readonly')
  const index = transaction.objectStore(OUTBOX).index('eventId')
  const operations = await requestResult(index.getAll(eventId)) as QueuedOperation[]
  return operations.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
}

export async function removeQueuedOperation(id: string): Promise<void> {
  await withStore(OUTBOX, 'readwrite', (store) => store.delete(id))
}

export async function countQueuedOperations(eventId: string): Promise<number> {
  const database = await openDatabase()
  const transaction = database.transaction(OUTBOX, 'readonly')
  const index = transaction.objectStore(OUTBOX).index('eventId')
  return requestResult(index.count(eventId))
}

export async function saveEventSnapshot<T>(snapshot: CachedEventState<T>): Promise<void> {
  await withStore(SNAPSHOTS, 'readwrite', (store) => store.put(snapshot))
}

export async function loadEventSnapshot<T>(eventId: string): Promise<CachedEventState<T> | undefined> {
  return withStore(SNAPSHOTS, 'readonly', (store) => store.get(eventId)) as Promise<CachedEventState<T> | undefined>
}

export async function saveMemberProfile(profile: LocalMemberProfile): Promise<void> {
  await withStore(PROFILES, 'readwrite', (store) => store.put(profile))
}

export async function loadMemberProfile(eventId: string): Promise<LocalMemberProfile | undefined> {
  return withStore(PROFILES, 'readonly', (store) => store.get(eventId)) as Promise<LocalMemberProfile | undefined>
}

export async function exportLocalEventData(eventId: string): Promise<string> {
  const [snapshot, outbox, profile] = await Promise.all([
    loadEventSnapshot(eventId),
    listQueuedOperations(eventId),
    loadMemberProfile(eventId),
  ])
  return JSON.stringify({
    format: 'srs-local-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    eventId,
    snapshot,
    outbox,
    profile,
  }, null, 2)
}

export function resetOfflineStoreForTests(): void {
  databaseInstance?.close()
  databaseInstance = undefined
  databasePromise = undefined
}
