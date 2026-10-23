// The sentence a person types before files are deleted from their storage.
// Exact match only: a near miss is far more likely to be a mistake than intent.

export function confirmationSentence(providerName: string): string {
  return `yes, delete my data in ${providerName}`;
}

export function confirmsDeletion(typed: string, sentence: string): boolean {
  return typed === sentence;
}
