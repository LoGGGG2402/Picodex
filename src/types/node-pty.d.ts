declare module "node-pty" {
  export interface IDisposable {
    dispose(): void;
  }

  export interface IExitEvent {
    exitCode: number;
    signal?: number;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }

  export interface IPty {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): IDisposable;
    onExit(listener: (event: IExitEvent) => void): IDisposable;
  }

  export function spawn(file: string, args?: string[], options?: IPtyForkOptions): IPty;
}
