export const FINALIZATION_AUTH_MAX_AGE_MINUTES = 15

export function raceFinalizationPhrase(raceNumber: string): string {
  return `${raceNumber.trim()}を確定`
}

export function isFinalizationPhraseValid(raceNumber: string, phrase: string): boolean {
  return phrase === raceFinalizationPhrase(raceNumber)
}
