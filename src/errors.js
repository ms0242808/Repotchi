'use strict';

const path = require('path');

/**
 * An error we chose to raise, carrying a hint the user can act on. Anything
 * else reaching the top level is a bug and gets reported as one.
 */
class PetError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'PetError';
    this.hint = hint || null;
    this.expected = true;
  }
}

/** Turns a raw filesystem error into something a human can act on. */
function describeFsError(err, target) {
  switch (err && err.code) {
    case 'EACCES':
    case 'EPERM':
      return new PetError(
        `no permission to write ${target}`,
        'check the directory permissions, or point REPOTCHI_HOME somewhere writable',
      );
    case 'ENOTDIR':
    case 'EEXIST':
      return new PetError(
        `${path.dirname(target)} is a file, not a directory`,
        'REPOTCHI_HOME must be a directory; remove that file or choose another path',
      );
    case 'ENOSPC':
      return new PetError(`no space left to write ${target}`, 'free some disk space and try again');
    case 'EROFS':
      return new PetError(`${target} is on a read-only filesystem`, 'set REPOTCHI_HOME to a writable location');
    default:
      return new PetError(
        `could not write ${target}: ${(err && err.message) || err}`,
        'set REPOTCHI_HOME to a writable location',
      );
  }
}

module.exports = { PetError, describeFsError };
