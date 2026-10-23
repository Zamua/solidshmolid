import { describe, expect, it } from 'vitest';
import { confirmationSentence, confirmsDeletion } from '../domain/deletion.js';

describe('deleting files needs the exact sentence', () => {
  const sentence = confirmationSentence('Dropbox');

  it('names the provider', () => {
    expect(sentence).toBe('yes, delete my data in Dropbox');
  });

  it('accepts only the exact sentence', () => {
    expect(confirmsDeletion(sentence, sentence)).toBe(true);
  });

  it.each([
    '',
    'yes',
    'yes, delete my data in Drop',
    'Yes, delete my data in Dropbox',
    'yes, delete my data in dropbox',
    'yes, delete my data in Dropbox ',
    ' yes, delete my data in Dropbox',
    'yes,  delete my data in Dropbox',
    'yes, delete my data in Google Drive',
    'yes, delete my data in Dropbox.',
  ])('refuses %j', (typed) => {
    expect(confirmsDeletion(typed, sentence)).toBe(false);
  });
});
