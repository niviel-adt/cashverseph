'use strict';
const crypto = require('node:crypto');
const {promisify} = require('node:util');
const scrypt = promisify(crypto.scrypt);
const error = message => Object.assign(new Error(message),{status:400});
const OPTIONS = {N:16384,r:8,p:1,maxmem:64*1024*1024};

async function makePasswordHash(password){
  if(typeof password!=='string'||password.length<10||password.length>128)
    throw error('Cashier passwords must be 10–128 characters.');
  const salt=crypto.randomBytes(16).toString('hex');
  const digest=await scrypt(password,Buffer.from(salt,'hex'),64,OPTIONS);
  return 'scrypt$'+salt+'$'+digest.toString('hex');
}

async function verifyPassword(password,stored){
  if(typeof password!=='string'||typeof stored!=='string')return false;
  const parts=stored.split('$');
  if(parts.length!==3||parts[0]!=='scrypt'||!/^[a-f0-9]{32}$/.test(parts[1])||
    !/^[a-f0-9]{128}$/.test(parts[2]))return false;
  const digest=await scrypt(password,Buffer.from(parts[1],'hex'),64,OPTIONS);
  return crypto.timingSafeEqual(digest,Buffer.from(parts[2],'hex'));
}

module.exports={makePasswordHash,verifyPassword};
