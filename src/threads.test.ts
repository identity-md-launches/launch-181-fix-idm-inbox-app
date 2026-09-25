import{beforeEach,describe,expect,it,vi}from'vitest';import{acceptRequest,buildThreads,openThread}from'./threads';import type{Transaction}from'./types';
const enc=(s:string)=>`0x${[...new TextEncoder().encode(s)].map(b=>b.toString(16).padStart(2,'0')).join('')}`;const owner='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';const tx=(from:string,to:string,text:string,time:string):Transaction=>({hash:crypto.randomUUID(),block_number:1,timestamp:time,result:'success',value:'0',raw_input:enc(text),from:{hash:from},to:{hash:to},successful:true});
describe('threads',()=>{beforeEach(()=>localStorage.clear());it('classifies and accepts requests',()=>{expect(buildThreads(owner,[tx(other,owner,'hello there','2026-01-01T00:00:00Z')],Date.parse('2026-02-01'))[0].request).toBe(true);acceptRequest(owner,other);expect(buildThreads(owner,[tx(other,owner,'hello there','2026-01-01T00:00:00Z')],Date.parse('2026-02-01'))[0].request).toBe(false)});it('sets first-view baseline and later unread state',()=>{expect(buildThreads(owner,[tx(other,owner,'old note','2026-01-01T00:00:00Z')],Date.parse('2026-02-01'))[0].unread).toBe(false);const newer=tx(other,owner,'new note','2026-03-01T00:00:00Z');expect(buildThreads(owner,[newer],Date.parse('2026-04-01'))[0].unread).toBe(true);openThread(owner,other,Date.parse('2026-03-02'));expect(buildThreads(owner,[newer])[0].unread).toBe(false)});it('survives throwing storage',()=>{vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('denied')});vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('denied')});expect(()=>buildThreads(owner,[tx(other,owner,'safe note','2026-01-01T00:00:00Z')])).not.toThrow()})});


describe('thread labels', () => {
  beforeEach(() => localStorage.clear());
  it('uses the counterparty of the last message, even after the owner has sent', () => {
    const sent = tx(owner, other, 'first from owner', '2026-01-01T00:00:00Z');
    sent.to = { hash: other, ens_domain_name: 'alice.eth' };
    const reply = tx(other, owner, 'reply from alice', '2026-01-02T00:00:00Z');
    reply.from = { hash: other, ens_domain_name: 'alice.eth' };
    reply.to = { hash: owner, ens_domain_name: 'owner.eth' };
    expect(buildThreads(owner, [sent, reply])[0].label).toBe('alice.eth');
    const last = tx(owner, other, 'owner again', '2026-01-03T00:00:00Z');
    last.from = { hash: owner, ens_domain_name: 'owner.eth' };
    last.to = { hash: other, ens_domain_name: 'alice.eth' };
    expect(buildThreads(owner, [sent, reply, last])[0].label).toBe('alice.eth');
  });
});
