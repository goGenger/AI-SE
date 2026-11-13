export function add(a: number, b: number): number {
  return a + b;
}

export function calculateDiscount(price: number, isPremiumUser: boolean): number {
  if (price < 0) {
    throw new Error("Price must be non-negative");
  }

  const discountRate = isPremiumUser ? 0.05 : 0.1;
  return Number((price * discountRate).toFixed(2));
}
