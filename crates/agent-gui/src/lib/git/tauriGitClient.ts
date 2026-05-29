import { invoke } from "@tauri-apps/api/core";
import {
  type GitClient,
  normalizeGitBranchesResponse,
  normalizeGitDiffResponse,
  normalizeGitOperationResponse,
  normalizeGitRepositoryState,
} from "./types";

export const tauriGitClient: GitClient = {
  async status(workdir) {
    return normalizeGitRepositoryState(await invoke("git_status", { workdir }), workdir);
  },
  async branches(workdir) {
    return normalizeGitBranchesResponse(await invoke("git_branches", { workdir }), workdir);
  },
  async switchBranch(workdir, branch, kind) {
    return normalizeGitOperationResponse(
      await invoke("git_switch_branch", { workdir, branch, kind }),
      workdir,
    );
  },
  async createBranch(workdir, branch) {
    return normalizeGitOperationResponse(
      await invoke("git_create_branch", { workdir, branch }),
      workdir,
    );
  },
  async diff(workdir, mode, path) {
    return normalizeGitDiffResponse(await invoke("git_diff", { workdir, mode, path }));
  },
  async stage(workdir, path) {
    return normalizeGitOperationResponse(await invoke("git_stage", { workdir, path }), workdir);
  },
  async stageAll(workdir) {
    return normalizeGitOperationResponse(await invoke("git_stage_all", { workdir }), workdir);
  },
  async unstage(workdir, path) {
    return normalizeGitOperationResponse(await invoke("git_unstage", { workdir, path }), workdir);
  },
  async unstageAll(workdir) {
    return normalizeGitOperationResponse(await invoke("git_unstage_all", { workdir }), workdir);
  },
  async discard(workdir, path, oldPath) {
    return normalizeGitOperationResponse(
      await invoke("git_discard", { workdir, path, old_path: oldPath }),
      workdir,
    );
  },
  async discardAll(workdir) {
    return normalizeGitOperationResponse(await invoke("git_discard_all", { workdir }), workdir);
  },
  async addToGitignore(workdir, path) {
    return normalizeGitOperationResponse(
      await invoke("git_add_to_gitignore", { workdir, path }),
      workdir,
    );
  },
  async commit(workdir, message) {
    return normalizeGitOperationResponse(await invoke("git_commit", { workdir, message }), workdir);
  },
  async fetch(workdir) {
    return normalizeGitOperationResponse(await invoke("git_fetch", { workdir }), workdir);
  },
  async pull(workdir) {
    return normalizeGitOperationResponse(await invoke("git_pull", { workdir }), workdir);
  },
  async push(workdir) {
    return normalizeGitOperationResponse(await invoke("git_push", { workdir }), workdir);
  },
};
