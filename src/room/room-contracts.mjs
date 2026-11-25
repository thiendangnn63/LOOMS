import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function createRoomContracts({ log, event }) {
  const directory = join(log.directory, 'contracts');

  function files() {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return [];
    if (!entry.isDirectory()) throw new Error('Invalid room contracts directory.');
    return readdirSync(directory, { withFileTypes: true });
  }

  function project({ contract, version }) {
    files();
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const filename = `${contract.id}.v${version}.md`;
    const path = join(directory, filename);
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current) {
      if (!current.isFile() || readFileSync(path, 'utf8') !== contract.content) {
        throw new Error(`Contract file ${filename} does not match its approved version.`);
      }
      return filename;
    }
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, contract.content, { flag: 'wx', mode: 0o600, flush: true });
    try {
      linkSync(temporary, path);
    } finally {
      unlinkSync(temporary);
    }
    return filename;
  }

  const updates = new Map(log.records().filter(message => message.kind === 'event' && message.from === 'system' &&
    message.contract_event?.type === 'updated').map(message => [message.reply_to, message.contract_event]));
  for (const update of updates.values()) project(update);

  function currentVersion(id) {
    const versions = files().filter(entry => entry.isFile()).map(entry => /^([a-z0-9_-]+)\.v([1-9]\d*)\.md$/i.exec(entry.name))
      .filter(match => match?.[1].toLowerCase() === id).map(match => Number(match[2]));
    const version = versions.reduce((latest, value) => Math.max(latest, value), 0);
    if (!Number.isSafeInteger(version + 1)) throw new Error(`Invalid contract version for ${id}.`);
    return version;
  }

  function propose(from, contract, planner) {
    if (reserved.test(contract.id)) throw new Error(`Invalid contract ID ${contract.id}.`);
    const version = currentVersion(contract.id);
    const proposal = event(`contract.proposed ${contract.id}`, { to: [planner], contract_event: {
      type: 'proposed', from, contract, version,
    } });
    return { proposal_id: proposal.id, contract: contract.id, planner, base_version: version };
  }

  function approve(from, planner, proposalID, visibleThrough) {
    if (from !== 'user' && from !== planner) throw new Error('Only the room planner or the human can approve a contract.');
    const proposal = log.records({ through: visibleThrough }).find(message => message.id === proposalID && message.from === 'system' &&
      message.kind === 'event' && message.contract_event?.type === 'proposed');
    if (!proposal) throw new Error(`Unknown contract proposal ${proposalID} in this snapshot.`);
    const { contract, version } = proposal.contract_event;
    let update = updates.get(proposalID);
    if (!update) {
      if (currentVersion(contract.id) !== version) throw new Error(`Contract ${contract.id} changed. Submit a proposal against the current version.`);
      update = { type: 'updated', from, contract, version: version + 1 };
      event(`contract.updated ${contract.id}@${update.version}`, { reply_to: proposalID, contract_event: update });
      updates.set(proposalID, update);
    }
    return { id: contract.id, version: update.version, file: `contracts/${project(update)}` };
  }

  function pending(through) {
    const entries = log.records({ through });
    const approved = new Set(entries.filter(message => message.contract_event?.type === 'updated').map(message => message.reply_to));
    return entries.filter(message => message.contract_event?.type === 'proposed' && !approved.has(message.id));
  }

  return { propose, approve, pending };
}
