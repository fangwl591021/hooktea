// Notification eligibility only; never changes webhook ownership or rewards.
// Exact command matching is intentional: "會員專區打不開" remains feedback.
export const normalizeMonitorCommand = value => String(value || '').normalize('NFKC').trim()
  .replace(/[\s\u200B-\u200D\uFEFF]+/g, '').toLowerCase();
const fixedCommands = new Set([
  '會員專區','會員中心','會員註冊','註冊','注册','加入會員','會員分享','分享好友',
  '推薦好友','邀請好友','會員打卡','打卡','虎克茶簽到贈點','我的推薦','推薦連結',
  '邀請連結','QR碼','QRCode','QR','綁定會員','會員綁定','綁定點數','我的點數',
].map(normalizeMonitorCommand));

export function isMonitorCommand(text, policy = {}) {
  const normalized = normalizeMonitorCommand(text);
  if (!normalized) return false;
  return fixedCommands.has(normalized) || (policy.keywords || []).includes(normalized);
}

export async function loadMonitorCommandPolicy(env) {
  // Request-scoped only: edits to campaign settings must also affect old outbox rows.
  // If settings cannot be verified, preserve evidence but hold notifications/analysis.
  let timer;
  try {
    const [settings, template] = await Promise.race([
      Promise.all(['SYSTEM_SETTINGS','HOOKTEA_CHECKIN_TEMPLATE'].map(async key => {
        const raw = await env.ACTION_DATA.get(key);
        const value = raw ? JSON.parse(raw) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_COMMAND_CONFIG');
        return value;
      })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('COMMAND_CONFIG_TIMEOUT')), 1500); }),
    ]);
    const rewards = String(settings.shop_keyword_reward_keywords || settings.shop_keyword_reward_keyword || '').split(/[,\n，;；]/);
    const templateKeywords = Array.isArray(template.keywords) ? template.keywords
      : String(template.keyword || template.trigger || '簽到贈點活動').split(/[\n,，]/);
    // Paused commands still are commands, not customer questions.
    const points=Math.max(0,Math.floor(Number(settings.shop_keyword_reward_points||0))||0);
    const daily=Number([env.HOOKTEA_DAILY_SIGNIN_POINTS,settings.hooktea_daily_signin_points,settings.shop_checkin_reward_points].find(v=>v!==undefined&&v!==null&&v!=='')??5);
    return {ready:true, keywords:[...new Set([...rewards, ...templateKeywords].map(normalizeMonitorCommand).filter(Boolean))],
      reward:{keywords:rewards.map(normalizeMonitorCommand).filter(Boolean),points,enabled:!['false','0'].includes(String(settings.shop_keyword_reward_enabled??'true').toLowerCase())&&Number.isSafeInteger(points)&&points>0},
      dailyPoints:!['false','0'].includes(String(settings.hooktea_daily_signin_enabled??'true').toLowerCase())&&Number.isSafeInteger(daily)&&daily>0?daily:0};
  } catch {
    return {ready:false, keywords:[]};
  } finally { clearTimeout(timer); }
}
