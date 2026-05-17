// Estado compartilhado entre handlers.js e scheduler.js
// Evita dependência circular: ambos importam daqui

// telegramUserId → { pendingBillId, subId, subName, category, dbUserId }
export const pendingBillAmount = new Map();
