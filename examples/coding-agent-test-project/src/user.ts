export interface User {
  id: string;
  name: string;
  isPremiumUser: boolean;
}

export function displayName(user: User): string {
  return user.name.trim() || "Anonymous";
}
