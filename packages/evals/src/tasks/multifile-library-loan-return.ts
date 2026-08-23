/**
 * Task: implement a feature whose correct behavior spans three files.
 *
 * `books.mjs` and `members.mjs` each keep their state in a module-private
 * `Map` and only expose narrow accessor functions — `getBookInfo` /
 * `getMemberInfo` hand back snapshots, not live references, so `loans.mjs`
 * cannot just reach in and mutate state directly. To implement
 * `returnBook` correctly the agent has to add a real "give a copy back"
 * function to `books.mjs`, a real "remove this loan" function to
 * `members.mjs`, and orchestrate both from `loans.mjs` — a change that only
 * works if all three files are read and edited consistently.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds, noFileDeleted } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const BOOKS_JS = `/**
 * Book inventory. State is private to this module — other modules must go
 * through these exported functions, never reach into the Map directly.
 */
const books = new Map();

export function addBook(isbn, title, copies) {
  books.set(isbn, { isbn, title, totalCopies: copies, available: copies });
}

/** Returns a snapshot (not a live reference) of a book's state. */
export function getBookInfo(isbn) {
  const book = books.get(isbn);
  return book ? { ...book } : undefined;
}

/** Takes one copy off the shelf. Returns false if none are available. */
export function takeCopy(isbn) {
  const book = books.get(isbn);
  if (!book || book.available <= 0) return false;
  book.available -= 1;
  return true;
}
`;

const MEMBERS_JS = `/**
 * Member registry. State is private to this module — other modules must go
 * through these exported functions, never reach into the Map directly.
 */
const members = new Map();
const MAX_ACTIVE_LOANS = 3;

export function addMember(id, name) {
  members.set(id, { id, name, activeLoanIsbns: [] });
}

/** Returns a snapshot (not a live reference) of a member's state. */
export function getMemberInfo(id) {
  const member = members.get(id);
  return member
    ? { id: member.id, name: member.name, activeLoanIsbns: [...member.activeLoanIsbns] }
    : undefined;
}

export function hasCapacity(id) {
  const member = members.get(id);
  return member !== undefined && member.activeLoanIsbns.length < MAX_ACTIVE_LOANS;
}

export function recordLoan(id, isbn) {
  const member = members.get(id);
  if (!member) return false;
  member.activeLoanIsbns.push(isbn);
  return true;
}
`;

const LOANS_JS = `import { getBookInfo, takeCopy } from "./books.mjs";
import { getMemberInfo, hasCapacity, recordLoan } from "./members.mjs";

export function borrowBook(memberId, isbn) {
  const member = getMemberInfo(memberId);
  const book = getBookInfo(isbn);
  if (!member || !book) return { ok: false, error: "not found" };
  if (!hasCapacity(memberId)) return { ok: false, error: "loan limit reached" };
  if (!takeCopy(isbn)) return { ok: false, error: "no copies available" };
  recordLoan(memberId, isbn);
  return { ok: true };
}

// TODO: implement returnBook(memberId, isbn). It must:
//  - fail with { ok: false } if the member does not currently have that
//    isbn on loan (and must not change any book or member state)
//  - increase the book's available count by one, never above its total
//    number of copies
//  - remove exactly one occurrence of isbn from the member's active loans
export function returnBook(memberId, isbn) {
  throw new Error("not implemented");
}
`;

const LIBRARY_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { addBook, getBookInfo } from "./books.mjs";
import { addMember, getMemberInfo } from "./members.mjs";
import { borrowBook, returnBook } from "./loans.mjs";

test("returning a borrowed book frees up a copy", () => {
  addBook("isbn-a", "Book A", 1);
  addMember("ma", "Alice A");
  assert.equal(borrowBook("ma", "isbn-a").ok, true);
  assert.equal(getBookInfo("isbn-a").available, 0);

  const result = returnBook("ma", "isbn-a");
  assert.equal(result.ok, true);
  assert.equal(getBookInfo("isbn-a").available, 1);
  assert.deepEqual(getMemberInfo("ma").activeLoanIsbns, []);
});

test("returning a book the member never borrowed fails and changes nothing", () => {
  addBook("isbn-b", "Book B", 1);
  addMember("mb", "Bob B");
  const result = returnBook("mb", "isbn-b");
  assert.equal(result.ok, false);
  assert.equal(getBookInfo("isbn-b").available, 1);
});

test("returning frees capacity so another book can be borrowed", () => {
  addBook("isbn-c1", "Book C1", 1);
  addBook("isbn-c2", "Book C2", 1);
  addBook("isbn-c3", "Book C3", 1);
  addBook("isbn-c4", "Book C4", 1);
  addMember("mc", "Carol C");
  assert.equal(borrowBook("mc", "isbn-c1").ok, true);
  assert.equal(borrowBook("mc", "isbn-c2").ok, true);
  assert.equal(borrowBook("mc", "isbn-c3").ok, true);
  // At the loan limit now.
  assert.equal(borrowBook("mc", "isbn-c4").ok, false);

  assert.equal(returnBook("mc", "isbn-c1").ok, true);
  // Capacity freed up: the previously-rejected borrow should now succeed.
  assert.equal(borrowBook("mc", "isbn-c4").ok, true);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { addBook, getBookInfo } from "../books.mjs";
import { addMember, getMemberInfo } from "../members.mjs";
import { borrowBook, returnBook } from "../loans.mjs";

// Independent of whatever the agent's own test file checks.

addBook("v-1", "Verify Book 1", 2);
addMember("v-alice", "Verify Alice");
addMember("v-bob", "Verify Bob");

assert.equal(borrowBook("v-alice", "v-1").ok, true);
assert.equal(borrowBook("v-bob", "v-1").ok, true, "second copy should still be available");
assert.equal(getBookInfo("v-1").available, 0, "both copies should now be checked out");

// Trap: returning a book neither member holds must not conjure a phantom copy.
addMember("v-carol", "Verify Carol");
const phantom = returnBook("v-carol", "v-1");
assert.equal(phantom.ok, false, "returning a book never borrowed by this member must fail");
assert.equal(getBookInfo("v-1").available, 0, "a failed return must not change availability");

// A real return restores exactly one copy, never more.
assert.equal(returnBook("v-alice", "v-1").ok, true);
assert.equal(getBookInfo("v-1").available, 1);
assert.deepEqual(getMemberInfo("v-alice").activeLoanIsbns, []);

// Returning the same book twice must fail the second time (already returned)
// and must never push availability above totalCopies.
const second = returnBook("v-alice", "v-1");
assert.equal(second.ok, false, "returning an already-returned book must fail");
assert.equal(getBookInfo("v-1").available, 1, "available must never exceed totalCopies");

// Loan-limit interaction: borrowing to the cap, returning one, then
// re-borrowing must reflect freed capacity accurately.
addBook("v-2", "Verify Book 2", 1);
addBook("v-3", "Verify Book 3", 1);
addBook("v-4", "Verify Book 4", 1);
addBook("v-5", "Verify Book 5", 1);
addMember("v-dave", "Verify Dave");
assert.equal(borrowBook("v-dave", "v-2").ok, true);
assert.equal(borrowBook("v-dave", "v-3").ok, true);
assert.equal(borrowBook("v-dave", "v-4").ok, true);
assert.equal(borrowBook("v-dave", "v-5").ok, false, "loan limit should block a 4th active loan");
assert.equal(returnBook("v-dave", "v-3").ok, true);
assert.equal(borrowBook("v-dave", "v-5").ok, true, "freed capacity should allow a new borrow");
assert.deepEqual(
  [...getMemberInfo("v-dave").activeLoanIsbns].sort(),
  ["v-2", "v-4", "v-5"],
  "active loans should reflect exactly the currently-held books",
);

console.log("verify: ok");
`;

export const multifileLibraryLoanReturn: EvalTask = {
  id: "multifile-library-loan-return",
  description:
    "Implement returnBook across three files (books.mjs, members.mjs, loans.mjs), keeping " +
    "inventory and loan-limit state consistent.",
  prompt:
    "This library system has borrowBook working (books.mjs, members.mjs, loans.mjs) but " +
    "returnBook in loans.mjs is not implemented. Implement it so a member can return a book " +
    "they currently have on loan: the book's available copy count must go back up (never " +
    "above its total number of copies), the loan must be removed from the member's active " +
    "loans, and returning a book the member does not currently have on loan must fail without " +
    "changing any state. books.mjs and members.mjs each keep their own state private (only " +
    "reachable through their exported functions) — add whatever functions you need there.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "books.mjs": BOOKS_JS,
      "members.mjs": MEMBERS_JS,
      "loans.mjs": LOANS_JS,
      "library.test.mjs": LIBRARY_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    noFileDeleted(["books.mjs", "members.mjs", "loans.mjs", "library.test.mjs"]),
  ],
  timeoutMs: 4 * 60_000,
  tags: ["multi-file", "state-management", "hard"],
};
