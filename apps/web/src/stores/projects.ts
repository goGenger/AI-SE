import { CreateProjectInput, Project } from "@ai-se/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import {
  attachProjectRepository as attachProjectRepositoryRequest,
  createProject as createProjectRequest,
  deleteProject as deleteProjectRequest,
  getProject,
  listProjects,
  updateProjectWorkspacePath as updateProjectWorkspacePathRequest
} from "../api/projects";

interface ProjectsState {
  projects: Project[];
  selectedProject: Project | null;
  loading: boolean;
  error: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

export const useProjectsStore = defineStore("projects", {
  state: (): ProjectsState => ({
    projects: [],
    selectedProject: null,
    loading: false,
    error: ""
  }),
  actions: {
    async fetchProjects() {
      this.loading = true;
      this.error = "";
      try {
        this.projects = await listProjects();
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },
    async fetchProject(id: string) {
      this.loading = true;
      this.error = "";
      try {
        this.selectedProject = await getProject(id);
      } catch (error) {
        this.selectedProject = null;
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },
    async createProject(input: CreateProjectInput) {
      const project = await createProjectRequest(input);
      this.projects = [project, ...this.projects.filter((entry) => entry.id !== project.id)];
      return project;
    },
    /** UX-01: 绑定仓库成功后同步选中项目与列表中的同一条记录。 */
    async attachRepository(id: string, repository: string) {
      const project = await attachProjectRepositoryRequest(id, repository);
      if (this.selectedProject?.id === id) {
        this.selectedProject = project;
      }
      this.projects = this.projects.map((entry) => (entry.id === id ? project : entry));
      return project;
    },
    async updateWorkspacePath(id: string, workspacePath: string) {
      const project = await updateProjectWorkspacePathRequest(id, workspacePath);
      if (this.selectedProject?.id === id) {
        this.selectedProject = project;
      }
      this.projects = this.projects.map((entry) => (entry.id === id ? project : entry));
      return project;
    },
    async deleteProject(id: string) {
      await deleteProjectRequest(id);
      this.projects = this.projects.filter((project) => project.id !== id);
      if (this.selectedProject?.id === id) {
        this.selectedProject = null;
      }
    }
  }
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectsStore, import.meta.hot));
}
