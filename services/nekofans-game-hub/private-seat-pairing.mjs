import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const digest=code=>createHash('sha256').update(code).digest();
// One independent, short-lived capability per authenticated seat. Pairing
// codes never appear in links; possession delegates only that same seat.
export function createSeatPairing({now=Date.now,ttlMs=60000}={}) {
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>120000)throw TypeError('invalid pairing lifetime');
  const slots=[null,null];
  function issue(seat){
    if(seat!==0&&seat!==1)throw TypeError('invalid seat');
    const code=randomBytes(18).toString('base64url');
    slots[seat]={hash:digest(code),expiresAt:now()+ttlMs};
    return {code,expiresInSeconds:Math.floor(ttlMs/1000)};
  }
  function redeem(code){
    if(typeof code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(code))return null;
    const candidate=digest(code),at=now();let matched=-1;
    for(let seat=0;seat<2;seat++){
      const slot=slots[seat];if(!slot)continue;
      if(at>=slot.expiresAt){slots[seat]=null;continue;}
      if(timingSafeEqual(candidate,slot.hash))matched=seat;
    }
    if(matched===-1)return null;
    slots[matched]=null;return {seat:matched};
  }
  return Object.freeze({issue,redeem});
}
