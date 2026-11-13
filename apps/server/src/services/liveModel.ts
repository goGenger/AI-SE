import type { LLMProvider, PlanningModel, PlanningModelRequest } from "@ai-se/agent-core";
import type { JsonObject } from "@ai-se/shared";
import { ModelConfigService } from "./modelConfigService";

/**
 * 这两个包装器解决同一个问题：组合根里有两条模型路径**只在启动时构造一次**
 * （planning 的模型、AgentRun 的 provider），而工作流任务那条路径是每次现构造的。
 * 不包的话，控制台改完配置只对后者生效 —— 「有时候管用」比「完全不管用」更难排查。
 *
 * 分工：**怎么建**由组合根通过 `build` 给出（它才知道要传哪些别的东西，如 sessionId），
 * **什么时候重建**由这里的版本号决定。每次调用前比对版本，变了就重建。
 *
 * 相比把 `PlanningModel` / `LLMProvider` 的依赖声明改成工厂函数，这样不动那两个服务的
 * 契约，也不动它们既有的测试。
 */
export class LiveLLMProvider implements LLMProvider {
  private cached?: LLMProvider;
  private cachedVersion = -1;

  constructor(
    private readonly config: ModelConfigService,
    private readonly build: () => LLMProvider
  ) {}

  private current(): LLMProvider {
    const version = this.config.getVersion();
    if (!this.cached || this.cachedVersion !== version) {
      this.cached = this.build();
      this.cachedVersion = version;
    }
    return this.cached;
  }

  invoke(...args: Parameters<LLMProvider["invoke"]>): ReturnType<LLMProvider["invoke"]> {
    return this.current().invoke(...args);
  }

  stream(...args: Parameters<LLMProvider["stream"]>): ReturnType<LLMProvider["stream"]> {
    return this.current().stream(...args);
  }

  bindTools(...args: Parameters<LLMProvider["bindTools"]>): LLMProvider {
    return this.current().bindTools(...args);
  }
}

export class LivePlanningModel implements PlanningModel {
  private cached?: PlanningModel;
  private cachedVersion = -1;

  constructor(
    private readonly config: ModelConfigService,
    private readonly build: () => PlanningModel
  ) {}

  private current(): PlanningModel {
    const version = this.config.getVersion();
    if (!this.cached || this.cachedVersion !== version) {
      this.cached = this.build();
      this.cachedVersion = version;
    }
    return this.cached;
  }

  generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    return this.current().generateStructured(request);
  }
}
