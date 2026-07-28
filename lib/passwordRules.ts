/**
 * Password rules, shared by the browser and the signup API route.
 *
 * Deliberately framework-free and with no 'use client': the API route must
 * apply exactly the same rules the UI shows, or the rules are only a
 * suggestion to anyone who skips the form.
 *
 * Length is the property that actually matters, so the floor is 8 rather than
 * Supabase's default 6, and anything on the common-password list is refused no
 * matter how many character classes it satisfies. Composition rules beyond
 * "not one repeated character" are absent on purpose — they push people
 * towards `Passw0rd!` and are not what stops an attacker.
 */

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyui', 'qwerty123', 'iloveyou', 'admin123', 'welcome1', 'welcome123',
  'letmein1', 'abc12345', 'football', 'baseball', 'sunshine', 'princess',
  'passw0rd', 'trustno1', 'zettamight', 'wheelchair',
]);

export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < 8) return 'Use at least 8 characters.';
  // bcrypt silently truncates past 72 bytes, so a longer password is a lie.
  if (password.length > 72) return 'Passwords cannot be longer than 72 characters.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'That password is too common — choose something else.';
  if (/^(.)\1+$/.test(password)) return 'That password is just one repeated character.';
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    return 'Do not put your email address in your password.';
  }
  return null;
}

/** 0–4, for the strength meter. Length-weighted, matching the rules above. */
export function passwordScore(password: string): number {
  if (!password) return 0;
  if (passwordProblem(password)) return password.length >= 6 ? 1 : 0;
  let score = 2;
  if (password.length >= 12) score += 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes >= 3 && password.length >= 10) score += 1;
  return Math.min(4, score);
}
