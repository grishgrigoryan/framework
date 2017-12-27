
import * as fs from '@barlus/node/fs'
import * as path from '@barlus/node/path'


// tar -x
import { Unpack, UnpackSync } from './unpack'

import { ReadStream, ReadStreamSync } from '../ext/minipass-fs'
import { options } from './high-level-opt';


export default function (opt_, files, cb) {
  if (typeof opt_ === 'function')
    cb = opt_, files = null, opt_ = {};
  else if (Array.isArray(opt_))
    files = opt_, opt_ = {};

  if (typeof files === 'function')
    cb = files, files = null;

  if (!files)
    files = [];
  else
    files = Array.from(files);

  const opt = options(opt_);

  if (opt.sync && typeof cb === 'function')
    throw new TypeError('callback not supported for sync tar functions');

  if (!opt.file && typeof cb === 'function')
    throw new TypeError('callback only supported with file option');

  if (files.length)
    filesFilter(opt, files);

  return opt.file && opt.sync ? extractFileSync(opt)
    : opt.file ? extractFile(opt, cb)
      : opt.sync ? extractSync(opt)
        : extract(opt)
}

// construct a filter that limits the file entries listed
// include child entries if a dir is included
export function filesFilter(opt, files) {
  const map = new Map(files.map(f => [f.replace(/\/+$/, ''), true]));
  const filter = opt.filter;

  const mapHas = (file, r?) => {
    const root = r || path.parse(file).root || '.';
    const ret = file === root ? false
      : map.has(file) ? map.get(file)
        : mapHas(path.dirname(file), root);

    map.set(file, ret);
    return ret
  };

  opt.filter = filter
    ? (file, entry) => filter(file, entry) && mapHas(file.replace(/\/+$/, ''))
    : file => mapHas(file.replace(/\/+$/, ''))
}

export function extractFileSync(opt) {
  const u = new UnpackSync(opt);

  const file = opt.file;
  let threw = true;
  let fd;
  const stat = fs.statSync(file);
  // This trades a zero-byte read() syscall for a stat
  // However, it will usually result in less memory allocation
  const readSize = opt.maxReadSize || 16 * 1024 * 1024;
  const stream = new ReadStreamSync(file, {
    readSize: readSize,
    size: stat.size
  });
  stream.pipe(u)
}

export function extractFile(opt, cb) {
  const u = new Unpack(opt);
  const readSize = opt.maxReadSize || 16 * 1024 * 1024;

  const file = opt.file;
  const p = new Promise((resolve, reject) => {
    u.on('error', reject);
    u.on('close', resolve);

    // This trades a zero-byte read() syscall for a stat
    // However, it will usually result in less memory allocation
    fs.stat(file, (er, stat) => {
      if (er)
        reject(er);
      else {
        const stream = new ReadStream(file, {
          readSize: readSize,
          size: stat.size
        });
        stream.on('error', reject);
        stream.pipe(u)
      }
    })
  });
  return cb ? p.then(cb, cb) : p
}

export function extractSync(opt) {
  return new UnpackSync(opt)
}

export function extract(opt) {
  return new Unpack(opt)
}