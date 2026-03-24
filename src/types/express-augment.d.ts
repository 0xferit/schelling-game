declare global {
  namespace Express {
    interface Request {
      accountId?: string | null;
    }
  }
}

export {};
