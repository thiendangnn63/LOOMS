// Per-room, per-agent skill pickers for `/skills` and `@agent /skills`.
// Pure UI glue: storage, validation and persistence live behind `app`.

const agentName = /^[a-z][a-z0-9_-]{0,79}$/u;
const maxLabel = 120;

function clean(text, limit = maxLabel) {
  const value = String(text ?? '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

function normalizeTarget(target) {
  if (target === undefined || target === null || target === '') return '';
  const name = String(target).trim().replace(/^@/u, '').toLowerCase();
  if (!agentName.test(name)) throw new Error('Use @agent /skills with a room member name.');
  return name;
}

export function createSkillMenus({ app, openMenu, setDraft }) {
  if (!app || typeof openMenu !== 'function' || typeof setDraft !== 'function') {
    throw new TypeError('createSkillMenus needs app, openMenu and setDraft.');
  }

  async function members() {
    const roster = await app.roster();
    const names = [];
    for (const member of Array.isArray(roster) ? roster : []) {
      const name = typeof member?.name === 'string' ? member.name.toLowerCase() : '';
      if (agentName.test(name) && !names.includes(name)) names.push(name);
    }
    return names;
  }

  async function skillsFor(target) {
    const list = await app.skills(target);
    return (Array.isArray(list) ? list : [])
      .filter(skill => typeof skill?.name === 'string' && skill.name)
      .map(skill => ({ name: skill.name, description: clean(skill.description, 80), enabled: skill.enabled === true }))
      .sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name, 'en'));
  }

  async function overview() {
    const names = await members();
    const options = [];
    for (const name of names) {
      const skills = await skillsFor(name);
      const enabled = skills.filter(skill => skill.enabled).length;
      options.push({
        label: `@${name} — ${enabled} enabled, ${skills.length - enabled} available`,
        select: () => agentMenu(name),
      });
    }
    if (!options.length) options.push({ label: 'No agents in this room', select: () => {} });
    await openMenu('Skills by agent', options);
  }

  async function agentMenu(target) {
    const names = await members();
    if (!names.includes(target)) throw new Error(`@${target} is not in this room.`);
    const options = (await skillsFor(target)).map(skill => {
      const detail = skill.description ? ` — ${skill.description}` : '';
      return {
        label: clean(`${skill.enabled ? 'Remove' : 'Enable'} /${skill.name}${detail}`),
        select: async () => {
          await app.setSkill(target, skill.name, !skill.enabled);
          await agentMenu(target);
        },
      };
    });
    await openMenu(`@${target} skills`, [
      { label: 'Import local skill…', select: () => setDraft(`@${target} /skills add `) },
      { label: 'Install from marketplace…', select: () => marketplaceMenu(target) },
      ...options,
      { label: 'All agents', select: () => overview() },
    ]);
  }

  async function marketplaceMenu(target) {
    const sources = await app.skillMarketplaces();
    openMenu(`Install skills for @${target}`, [
      ...sources.map(market => ({
        label: `${market.name} · ${market.repo} · ${market.skills.length} skills`,
        select: () => openMenu(market.name, [
          ...market.skills.map(skill => ({
            label: skill.group ? `${skill.id} · ${skill.group}` : skill.id,
            select: async () => {
              await app.installMarketplaceSkill(target, `${skill.id}@${market.name}`);
              await agentMenu(target);
            },
          })),
          { label: 'All marketplaces', select: () => marketplaceMenu(target) },
        ]),
      })),
      { label: 'Add marketplace…', select: () => setDraft('/skills marketplace add ') },
      { label: `Back to @${target} skills`, select: () => agentMenu(target) },
    ]);
  }

  return {
    async open(target) {
      const name = normalizeTarget(target);
      await (name ? agentMenu(name) : overview());
    },
  };
}
