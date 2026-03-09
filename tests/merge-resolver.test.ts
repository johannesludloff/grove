import { describe, test, expect } from "bun:test";
import { resolveConflictMarkers } from "../src/merge-resolver";

describe("merge-resolver", () => {
	describe("resolveConflictMarkers", () => {
		test("keeps incoming (theirs) side of conflict", () => {
			const input = [
				"line before",
				"<<<<<<< HEAD",
				"ours content",
				"=======",
				"theirs content",
				">>>>>>> branch",
				"line after",
			].join("\n");

			const result = resolveConflictMarkers(input);
			expect(result).toBe(
				["line before", "theirs content", "line after"].join("\n"),
			);
		});

		test("returns content unchanged when no conflicts", () => {
			const input = "line 1\nline 2\nline 3";
			expect(resolveConflictMarkers(input)).toBe(input);
		});

		test("handles multiple conflict blocks", () => {
			const input = [
				"before",
				"<<<<<<< HEAD",
				"ours 1",
				"=======",
				"theirs 1",
				">>>>>>> branch",
				"middle",
				"<<<<<<< HEAD",
				"ours 2",
				"=======",
				"theirs 2",
				">>>>>>> branch",
				"after",
			].join("\n");

			const result = resolveConflictMarkers(input);
			expect(result).toBe(
				["before", "theirs 1", "middle", "theirs 2", "after"].join(
					"\n",
				),
			);
		});

		test("handles empty ours side (new content added by branch)", () => {
			const input = [
				"start",
				"<<<<<<< HEAD",
				"=======",
				"new content",
				">>>>>>> branch",
				"end",
			].join("\n");

			const result = resolveConflictMarkers(input);
			expect(result).toBe(
				["start", "new content", "end"].join("\n"),
			);
		});

		test("handles empty theirs side (content deleted by branch)", () => {
			const input = [
				"start",
				"<<<<<<< HEAD",
				"old content",
				"=======",
				">>>>>>> branch",
				"end",
			].join("\n");

			const result = resolveConflictMarkers(input);
			// Empty theirs side means the conflicted content is deleted entirely
			expect(result).toBe(["start", "end"].join("\n"));
		});

		test("handles multi-line conflict sections", () => {
			const input = [
				"header",
				"<<<<<<< HEAD",
				"ours line 1",
				"ours line 2",
				"ours line 3",
				"=======",
				"theirs line 1",
				"theirs line 2",
				">>>>>>> branch",
				"footer",
			].join("\n");

			const result = resolveConflictMarkers(input);
			expect(result).toBe(
				[
					"header",
					"theirs line 1",
					"theirs line 2",
					"footer",
				].join("\n"),
			);
		});

		test("handles conflict at start of file", () => {
			const input = [
				"<<<<<<< HEAD",
				"old header",
				"=======",
				"new header",
				">>>>>>> branch",
				"rest of file",
			].join("\n");

			const result = resolveConflictMarkers(input);
			expect(result).toBe(
				["new header", "rest of file"].join("\n"),
			);
		});

		test("handles conflict at end of file", () => {
			const input = [
				"start of file",
				"<<<<<<< HEAD",
				"old footer",
				"=======",
				"new footer",
				">>>>>>> branch",
			].join("\n");

			const result = resolveConflictMarkers(input);
			expect(result).toBe(
				["start of file", "new footer"].join("\n"),
			);
		});

		test("preserves indentation in resolved content", () => {
			const input = [
				"function foo() {",
				"<<<<<<< HEAD",
				"    return 1;",
				"=======",
				"    return 2;",
				">>>>>>> branch",
				"}",
			].join("\n");

			const result = resolveConflictMarkers(input);
			expect(result).toBe(
				["function foo() {", "    return 2;", "}"].join("\n"),
			);
		});
	});
});
