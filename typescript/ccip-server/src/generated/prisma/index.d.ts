
/**
 * Client
**/

import * as runtime from './runtime/library.js';
import $Types = runtime.Types // general types
import $Public = runtime.Types.Public
import $Utils = runtime.Types.Utils
import $Extensions = runtime.Types.Extensions
import $Result = runtime.Types.Result

export type PrismaPromise<T> = $Public.PrismaPromise<T>


/**
 * Model Commitment
 * 
 */
export type Commitment = $Result.DefaultSelection<Prisma.$CommitmentPayload>

/**
 * ##  Prisma Client ʲˢ
 *
 * Type-safe database client for TypeScript & Node.js
 * @example
 * ```
 * const prisma = new PrismaClient()
 * // Fetch zero or more Commitments
 * const commitments = await prisma.commitment.findMany()
 * ```
 *
 *
 * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client).
 */
export class PrismaClient<
  ClientOptions extends Prisma.PrismaClientOptions = Prisma.PrismaClientOptions,
  U = 'log' extends keyof ClientOptions ? ClientOptions['log'] extends Array<Prisma.LogLevel | Prisma.LogDefinition> ? Prisma.GetEvents<ClientOptions['log']> : never : never,
  ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs
> {
  [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['other'] }

    /**
   * ##  Prisma Client ʲˢ
   *
   * Type-safe database client for TypeScript & Node.js
   * @example
   * ```
   * const prisma = new PrismaClient()
   * // Fetch zero or more Commitments
   * const commitments = await prisma.commitment.findMany()
   * ```
   *
   *
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client).
   */

  constructor(optionsArg ?: Prisma.Subset<ClientOptions, Prisma.PrismaClientOptions>);
  $on<V extends U>(eventType: V, callback: (event: V extends 'query' ? Prisma.QueryEvent : Prisma.LogEvent) => void): PrismaClient;

  /**
   * Connect with the database
   */
  $connect(): $Utils.JsPromise<void>;

  /**
   * Disconnect from the database
   */
  $disconnect(): $Utils.JsPromise<void>;

  /**
   * Add a middleware
   * @deprecated since 4.16.0. For new code, prefer client extensions instead.
   * @see https://pris.ly/d/extensions
   */
  $use(cb: Prisma.Middleware): void

/**
   * Executes a prepared raw query and returns the number of affected rows.
   * @example
   * ```
   * const result = await prisma.$executeRaw`UPDATE User SET cool = ${true} WHERE email = ${'user@email.com'};`
   * ```
   *
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $executeRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Prisma.PrismaPromise<number>;

  /**
   * Executes a raw query and returns the number of affected rows.
   * Susceptible to SQL injections, see documentation.
   * @example
   * ```
   * const result = await prisma.$executeRawUnsafe('UPDATE User SET cool = $1 WHERE email = $2 ;', true, 'user@email.com')
   * ```
   *
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $executeRawUnsafe<T = unknown>(query: string, ...values: any[]): Prisma.PrismaPromise<number>;

  /**
   * Performs a prepared raw query and returns the `SELECT` data.
   * @example
   * ```
   * const result = await prisma.$queryRaw`SELECT * FROM User WHERE id = ${1} OR email = ${'user@email.com'};`
   * ```
   *
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Prisma.PrismaPromise<T>;

  /**
   * Performs a raw query and returns the `SELECT` data.
   * Susceptible to SQL injections, see documentation.
   * @example
   * ```
   * const result = await prisma.$queryRawUnsafe('SELECT * FROM User WHERE id = $1 OR email = $2;', 1, 'user@email.com')
   * ```
   *
   * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/raw-database-access).
   */
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Prisma.PrismaPromise<T>;


  /**
   * Allows the running of a sequence of read/write operations that are guaranteed to either succeed or fail as a whole.
   * @example
   * ```
   * const [george, bob, alice] = await prisma.$transaction([
   *   prisma.user.create({ data: { name: 'George' } }),
   *   prisma.user.create({ data: { name: 'Bob' } }),
   *   prisma.user.create({ data: { name: 'Alice' } }),
   * ])
   * ```
   * 
   * Read more in our [docs](https://www.prisma.io/docs/concepts/components/prisma-client/transactions).
   */
  $transaction<P extends Prisma.PrismaPromise<any>[]>(arg: [...P], options?: { isolationLevel?: Prisma.TransactionIsolationLevel }): $Utils.JsPromise<runtime.Types.Utils.UnwrapTuple<P>>

  $transaction<R>(fn: (prisma: Omit<PrismaClient, runtime.ITXClientDenyList>) => $Utils.JsPromise<R>, options?: { maxWait?: number, timeout?: number, isolationLevel?: Prisma.TransactionIsolationLevel }): $Utils.JsPromise<R>


  $extends: $Extensions.ExtendsHook<"extends", Prisma.TypeMapCb<ClientOptions>, ExtArgs, $Utils.Call<Prisma.TypeMapCb<ClientOptions>, {
    extArgs: ExtArgs
  }>>

      /**
   * `prisma.commitment`: Exposes CRUD operations for the **Commitment** model.
    * Example usage:
    * ```ts
    * // Fetch zero or more Commitments
    * const commitments = await prisma.commitment.findMany()
    * ```
    */
  get commitment(): Prisma.CommitmentDelegate<ExtArgs, ClientOptions>;
}

export namespace Prisma {
  export import DMMF = runtime.DMMF

  export type PrismaPromise<T> = $Public.PrismaPromise<T>

  /**
   * Validator
   */
  export import validator = runtime.Public.validator

  /**
   * Prisma Errors
   */
  export import PrismaClientKnownRequestError = runtime.PrismaClientKnownRequestError
  export import PrismaClientUnknownRequestError = runtime.PrismaClientUnknownRequestError
  export import PrismaClientRustPanicError = runtime.PrismaClientRustPanicError
  export import PrismaClientInitializationError = runtime.PrismaClientInitializationError
  export import PrismaClientValidationError = runtime.PrismaClientValidationError

  /**
   * Re-export of sql-template-tag
   */
  export import sql = runtime.sqltag
  export import empty = runtime.empty
  export import join = runtime.join
  export import raw = runtime.raw
  export import Sql = runtime.Sql



  /**
   * Decimal.js
   */
  export import Decimal = runtime.Decimal

  export type DecimalJsLike = runtime.DecimalJsLike

  /**
   * Metrics
   */
  export type Metrics = runtime.Metrics
  export type Metric<T> = runtime.Metric<T>
  export type MetricHistogram = runtime.MetricHistogram
  export type MetricHistogramBucket = runtime.MetricHistogramBucket

  /**
  * Extensions
  */
  export import Extension = $Extensions.UserArgs
  export import getExtensionContext = runtime.Extensions.getExtensionContext
  export import Args = $Public.Args
  export import Payload = $Public.Payload
  export import Result = $Public.Result
  export import Exact = $Public.Exact

  /**
   * Prisma Client JS version: 6.8.2
   * Query Engine version: 2060c79ba17c6bb9f5823312b6f6b7f4a845738e
   */
  export type PrismaVersion = {
    client: string
  }

  export const prismaVersion: PrismaVersion

  /**
   * Utility Types
   */


  export import JsonObject = runtime.JsonObject
  export import JsonArray = runtime.JsonArray
  export import JsonValue = runtime.JsonValue
  export import InputJsonObject = runtime.InputJsonObject
  export import InputJsonArray = runtime.InputJsonArray
  export import InputJsonValue = runtime.InputJsonValue

  /**
   * Types of the values used to represent different kinds of `null` values when working with JSON fields.
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  namespace NullTypes {
    /**
    * Type of `Prisma.DbNull`.
    *
    * You cannot use other instances of this class. Please use the `Prisma.DbNull` value.
    *
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class DbNull {
      private DbNull: never
      private constructor()
    }

    /**
    * Type of `Prisma.JsonNull`.
    *
    * You cannot use other instances of this class. Please use the `Prisma.JsonNull` value.
    *
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class JsonNull {
      private JsonNull: never
      private constructor()
    }

    /**
    * Type of `Prisma.AnyNull`.
    *
    * You cannot use other instances of this class. Please use the `Prisma.AnyNull` value.
    *
    * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
    */
    class AnyNull {
      private AnyNull: never
      private constructor()
    }
  }

  /**
   * Helper for filtering JSON entries that have `null` on the database (empty on the db)
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const DbNull: NullTypes.DbNull

  /**
   * Helper for filtering JSON entries that have JSON `null` values (not empty on the db)
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const JsonNull: NullTypes.JsonNull

  /**
   * Helper for filtering JSON entries that are `Prisma.DbNull` or `Prisma.JsonNull`
   *
   * @see https://www.prisma.io/docs/concepts/components/prisma-client/working-with-fields/working-with-json-fields#filtering-on-a-json-field
   */
  export const AnyNull: NullTypes.AnyNull

  type SelectAndInclude = {
    select: any
    include: any
  }

  type SelectAndOmit = {
    select: any
    omit: any
  }

  /**
   * Get the type of the value, that the Promise holds.
   */
  export type PromiseType<T extends PromiseLike<any>> = T extends PromiseLike<infer U> ? U : T;

  /**
   * Get the return type of a function which returns a Promise.
   */
  export type PromiseReturnType<T extends (...args: any) => $Utils.JsPromise<any>> = PromiseType<ReturnType<T>>

  /**
   * From T, pick a set of properties whose keys are in the union K
   */
  type Prisma__Pick<T, K extends keyof T> = {
      [P in K]: T[P];
  };


  export type Enumerable<T> = T | Array<T>;

  export type RequiredKeys<T> = {
    [K in keyof T]-?: {} extends Prisma__Pick<T, K> ? never : K
  }[keyof T]

  export type TruthyKeys<T> = keyof {
    [K in keyof T as T[K] extends false | undefined | null ? never : K]: K
  }

  export type TrueKeys<T> = TruthyKeys<Prisma__Pick<T, RequiredKeys<T>>>

  /**
   * Subset
   * @desc From `T` pick properties that exist in `U`. Simple version of Intersection
   */
  export type Subset<T, U> = {
    [key in keyof T]: key extends keyof U ? T[key] : never;
  };

  /**
   * SelectSubset
   * @desc From `T` pick properties that exist in `U`. Simple version of Intersection.
   * Additionally, it validates, if both select and include are present. If the case, it errors.
   */
  export type SelectSubset<T, U> = {
    [key in keyof T]: key extends keyof U ? T[key] : never
  } &
    (T extends SelectAndInclude
      ? 'Please either choose `select` or `include`.'
      : T extends SelectAndOmit
        ? 'Please either choose `select` or `omit`.'
        : {})

  /**
   * Subset + Intersection
   * @desc From `T` pick properties that exist in `U` and intersect `K`
   */
  export type SubsetIntersection<T, U, K> = {
    [key in keyof T]: key extends keyof U ? T[key] : never
  } &
    K

  type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };

  /**
   * XOR is needed to have a real mutually exclusive union type
   * https://stackoverflow.com/questions/42123407/does-typescript-support-mutually-exclusive-types
   */
  type XOR<T, U> =
    T extends object ?
    U extends object ?
      (Without<T, U> & U) | (Without<U, T> & T)
    : U : T


  /**
   * Is T a Record?
   */
  type IsObject<T extends any> = T extends Array<any>
  ? False
  : T extends Date
  ? False
  : T extends Uint8Array
  ? False
  : T extends BigInt
  ? False
  : T extends object
  ? True
  : False


  /**
   * If it's T[], return T
   */
  export type UnEnumerate<T extends unknown> = T extends Array<infer U> ? U : T

  /**
   * From ts-toolbelt
   */

  type __Either<O extends object, K extends Key> = Omit<O, K> &
    {
      // Merge all but K
      [P in K]: Prisma__Pick<O, P & keyof O> // With K possibilities
    }[K]

  type EitherStrict<O extends object, K extends Key> = Strict<__Either<O, K>>

  type EitherLoose<O extends object, K extends Key> = ComputeRaw<__Either<O, K>>

  type _Either<
    O extends object,
    K extends Key,
    strict extends Boolean
  > = {
    1: EitherStrict<O, K>
    0: EitherLoose<O, K>
  }[strict]

  type Either<
    O extends object,
    K extends Key,
    strict extends Boolean = 1
  > = O extends unknown ? _Either<O, K, strict> : never

  export type Union = any

  type PatchUndefined<O extends object, O1 extends object> = {
    [K in keyof O]: O[K] extends undefined ? At<O1, K> : O[K]
  } & {}

  /** Helper Types for "Merge" **/
  export type IntersectOf<U extends Union> = (
    U extends unknown ? (k: U) => void : never
  ) extends (k: infer I) => void
    ? I
    : never

  export type Overwrite<O extends object, O1 extends object> = {
      [K in keyof O]: K extends keyof O1 ? O1[K] : O[K];
  } & {};

  type _Merge<U extends object> = IntersectOf<Overwrite<U, {
      [K in keyof U]-?: At<U, K>;
  }>>;

  type Key = string | number | symbol;
  type AtBasic<O extends object, K extends Key> = K extends keyof O ? O[K] : never;
  type AtStrict<O extends object, K extends Key> = O[K & keyof O];
  type AtLoose<O extends object, K extends Key> = O extends unknown ? AtStrict<O, K> : never;
  export type At<O extends object, K extends Key, strict extends Boolean = 1> = {
      1: AtStrict<O, K>;
      0: AtLoose<O, K>;
  }[strict];

  export type ComputeRaw<A extends any> = A extends Function ? A : {
    [K in keyof A]: A[K];
  } & {};

  export type OptionalFlat<O> = {
    [K in keyof O]?: O[K];
  } & {};

  type _Record<K extends keyof any, T> = {
    [P in K]: T;
  };

  // cause typescript not to expand types and preserve names
  type NoExpand<T> = T extends unknown ? T : never;

  // this type assumes the passed object is entirely optional
  type AtLeast<O extends object, K extends string> = NoExpand<
    O extends unknown
    ? | (K extends keyof O ? { [P in K]: O[P] } & O : O)
      | {[P in keyof O as P extends K ? P : never]-?: O[P]} & O
    : never>;

  type _Strict<U, _U = U> = U extends unknown ? U & OptionalFlat<_Record<Exclude<Keys<_U>, keyof U>, never>> : never;

  export type Strict<U extends object> = ComputeRaw<_Strict<U>>;
  /** End Helper Types for "Merge" **/

  export type Merge<U extends object> = ComputeRaw<_Merge<Strict<U>>>;

  /**
  A [[Boolean]]
  */
  export type Boolean = True | False

  // /**
  // 1
  // */
  export type True = 1

  /**
  0
  */
  export type False = 0

  export type Not<B extends Boolean> = {
    0: 1
    1: 0
  }[B]

  export type Extends<A1 extends any, A2 extends any> = [A1] extends [never]
    ? 0 // anything `never` is false
    : A1 extends A2
    ? 1
    : 0

  export type Has<U extends Union, U1 extends Union> = Not<
    Extends<Exclude<U1, U>, U1>
  >

  export type Or<B1 extends Boolean, B2 extends Boolean> = {
    0: {
      0: 0
      1: 1
    }
    1: {
      0: 1
      1: 1
    }
  }[B1][B2]

  export type Keys<U extends Union> = U extends unknown ? keyof U : never

  type Cast<A, B> = A extends B ? A : B;

  export const type: unique symbol;



  /**
   * Used by group by
   */

  export type GetScalarType<T, O> = O extends object ? {
    [P in keyof T]: P extends keyof O
      ? O[P]
      : never
  } : never

  type FieldPaths<
    T,
    U = Omit<T, '_avg' | '_sum' | '_count' | '_min' | '_max'>
  > = IsObject<T> extends True ? U : T

  type GetHavingFields<T> = {
    [K in keyof T]: Or<
      Or<Extends<'OR', K>, Extends<'AND', K>>,
      Extends<'NOT', K>
    > extends True
      ? // infer is only needed to not hit TS limit
        // based on the brilliant idea of Pierre-Antoine Mills
        // https://github.com/microsoft/TypeScript/issues/30188#issuecomment-478938437
        T[K] extends infer TK
        ? GetHavingFields<UnEnumerate<TK> extends object ? Merge<UnEnumerate<TK>> : never>
        : never
      : {} extends FieldPaths<T[K]>
      ? never
      : K
  }[keyof T]

  /**
   * Convert tuple to union
   */
  type _TupleToUnion<T> = T extends (infer E)[] ? E : never
  type TupleToUnion<K extends readonly any[]> = _TupleToUnion<K>
  type MaybeTupleToUnion<T> = T extends any[] ? TupleToUnion<T> : T

  /**
   * Like `Pick`, but additionally can also accept an array of keys
   */
  type PickEnumerable<T, K extends Enumerable<keyof T> | keyof T> = Prisma__Pick<T, MaybeTupleToUnion<K>>

  /**
   * Exclude all keys with underscores
   */
  type ExcludeUnderscoreKeys<T extends string> = T extends `_${string}` ? never : T


  export type FieldRef<Model, FieldType> = runtime.FieldRef<Model, FieldType>

  type FieldRefInputType<Model, FieldType> = Model extends never ? never : FieldRef<Model, FieldType>


  export const ModelName: {
    Commitment: 'Commitment'
  };

  export type ModelName = (typeof ModelName)[keyof typeof ModelName]


  export type Datasources = {
    db?: Datasource
  }

  interface TypeMapCb<ClientOptions = {}> extends $Utils.Fn<{extArgs: $Extensions.InternalArgs }, $Utils.Record<string, any>> {
    returns: Prisma.TypeMap<this['params']['extArgs'], ClientOptions extends { omit: infer OmitOptions } ? OmitOptions : {}>
  }

  export type TypeMap<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> = {
    globalOmitOptions: {
      omit: GlobalOmitOptions
    }
    meta: {
      modelProps: "commitment"
      txIsolationLevel: Prisma.TransactionIsolationLevel
    }
    model: {
      Commitment: {
        payload: Prisma.$CommitmentPayload<ExtArgs>
        fields: Prisma.CommitmentFieldRefs
        operations: {
          findUnique: {
            args: Prisma.CommitmentFindUniqueArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload> | null
          }
          findUniqueOrThrow: {
            args: Prisma.CommitmentFindUniqueOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>
          }
          findFirst: {
            args: Prisma.CommitmentFindFirstArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload> | null
          }
          findFirstOrThrow: {
            args: Prisma.CommitmentFindFirstOrThrowArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>
          }
          findMany: {
            args: Prisma.CommitmentFindManyArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>[]
          }
          create: {
            args: Prisma.CommitmentCreateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>
          }
          createMany: {
            args: Prisma.CommitmentCreateManyArgs<ExtArgs>
            result: BatchPayload
          }
          createManyAndReturn: {
            args: Prisma.CommitmentCreateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>[]
          }
          delete: {
            args: Prisma.CommitmentDeleteArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>
          }
          update: {
            args: Prisma.CommitmentUpdateArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>
          }
          deleteMany: {
            args: Prisma.CommitmentDeleteManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateMany: {
            args: Prisma.CommitmentUpdateManyArgs<ExtArgs>
            result: BatchPayload
          }
          updateManyAndReturn: {
            args: Prisma.CommitmentUpdateManyAndReturnArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>[]
          }
          upsert: {
            args: Prisma.CommitmentUpsertArgs<ExtArgs>
            result: $Utils.PayloadToResult<Prisma.$CommitmentPayload>
          }
          aggregate: {
            args: Prisma.CommitmentAggregateArgs<ExtArgs>
            result: $Utils.Optional<AggregateCommitment>
          }
          groupBy: {
            args: Prisma.CommitmentGroupByArgs<ExtArgs>
            result: $Utils.Optional<CommitmentGroupByOutputType>[]
          }
          count: {
            args: Prisma.CommitmentCountArgs<ExtArgs>
            result: $Utils.Optional<CommitmentCountAggregateOutputType> | number
          }
        }
      }
    }
  } & {
    other: {
      payload: any
      operations: {
        $executeRaw: {
          args: [query: TemplateStringsArray | Prisma.Sql, ...values: any[]],
          result: any
        }
        $executeRawUnsafe: {
          args: [query: string, ...values: any[]],
          result: any
        }
        $queryRaw: {
          args: [query: TemplateStringsArray | Prisma.Sql, ...values: any[]],
          result: any
        }
        $queryRawUnsafe: {
          args: [query: string, ...values: any[]],
          result: any
        }
      }
    }
  }
  export const defineExtension: $Extensions.ExtendsHook<"define", Prisma.TypeMapCb, $Extensions.DefaultArgs>
  export type DefaultPrismaClient = PrismaClient
  export type ErrorFormat = 'pretty' | 'colorless' | 'minimal'
  export interface PrismaClientOptions {
    /**
     * Overwrites the datasource url from your schema.prisma file
     */
    datasources?: Datasources
    /**
     * Overwrites the datasource url from your schema.prisma file
     */
    datasourceUrl?: string
    /**
     * @default "colorless"
     */
    errorFormat?: ErrorFormat
    /**
     * @example
     * ```
     * // Defaults to stdout
     * log: ['query', 'info', 'warn', 'error']
     * 
     * // Emit as events
     * log: [
     *   { emit: 'stdout', level: 'query' },
     *   { emit: 'stdout', level: 'info' },
     *   { emit: 'stdout', level: 'warn' }
     *   { emit: 'stdout', level: 'error' }
     * ]
     * ```
     * Read more in our [docs](https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-client/logging#the-log-option).
     */
    log?: (LogLevel | LogDefinition)[]
    /**
     * The default values for transactionOptions
     * maxWait ?= 2000
     * timeout ?= 5000
     */
    transactionOptions?: {
      maxWait?: number
      timeout?: number
      isolationLevel?: Prisma.TransactionIsolationLevel
    }
    /**
     * Global configuration for omitting model fields by default.
     * 
     * @example
     * ```
     * const prisma = new PrismaClient({
     *   omit: {
     *     user: {
     *       password: true
     *     }
     *   }
     * })
     * ```
     */
    omit?: Prisma.GlobalOmitConfig
  }
  export type GlobalOmitConfig = {
    commitment?: CommitmentOmit
  }

  /* Types for Logging */
  export type LogLevel = 'info' | 'query' | 'warn' | 'error'
  export type LogDefinition = {
    level: LogLevel
    emit: 'stdout' | 'event'
  }

  export type GetLogType<T extends LogLevel | LogDefinition> = T extends LogDefinition ? T['emit'] extends 'event' ? T['level'] : never : never
  export type GetEvents<T extends any> = T extends Array<LogLevel | LogDefinition> ?
    GetLogType<T[0]> | GetLogType<T[1]> | GetLogType<T[2]> | GetLogType<T[3]>
    : never

  export type QueryEvent = {
    timestamp: Date
    query: string
    params: string
    duration: number
    target: string
  }

  export type LogEvent = {
    timestamp: Date
    message: string
    target: string
  }
  /* End Types for Logging */


  export type PrismaAction =
    | 'findUnique'
    | 'findUniqueOrThrow'
    | 'findMany'
    | 'findFirst'
    | 'findFirstOrThrow'
    | 'create'
    | 'createMany'
    | 'createManyAndReturn'
    | 'update'
    | 'updateMany'
    | 'updateManyAndReturn'
    | 'upsert'
    | 'delete'
    | 'deleteMany'
    | 'executeRaw'
    | 'queryRaw'
    | 'aggregate'
    | 'count'
    | 'runCommandRaw'
    | 'findRaw'
    | 'groupBy'

  /**
   * These options are being passed into the middleware as "params"
   */
  export type MiddlewareParams = {
    model?: ModelName
    action: PrismaAction
    args: any
    dataPath: string[]
    runInTransaction: boolean
  }

  /**
   * The `T` type makes sure, that the `return proceed` is not forgotten in the middleware implementation
   */
  export type Middleware<T = any> = (
    params: MiddlewareParams,
    next: (params: MiddlewareParams) => $Utils.JsPromise<T>,
  ) => $Utils.JsPromise<T>

  // tested in getLogLevel.test.ts
  export function getLogLevel(log: Array<LogLevel | LogDefinition>): LogLevel | undefined;

  /**
   * `PrismaClient` proxy available in interactive transactions.
   */
  export type TransactionClient = Omit<Prisma.DefaultPrismaClient, runtime.ITXClientDenyList>

  export type Datasource = {
    url?: string
  }

  /**
   * Count Types
   */



  /**
   * Models
   */

  /**
   * Model Commitment
   */

  export type AggregateCommitment = {
    _count: CommitmentCountAggregateOutputType | null
    _avg: CommitmentAvgAggregateOutputType | null
    _sum: CommitmentSumAggregateOutputType | null
    _min: CommitmentMinAggregateOutputType | null
    _max: CommitmentMaxAggregateOutputType | null
  }

  export type CommitmentAvgAggregateOutputType = {
    originDomain: number | null
  }

  export type CommitmentSumAggregateOutputType = {
    originDomain: number | null
  }

  export type CommitmentMinAggregateOutputType = {
    commitment: string | null
    revealMessageId: string | null
    salt: string | null
    ica: string | null
    commitmentDispatchTx: string | null
    originDomain: number | null
    createdAt: Date | null
  }

  export type CommitmentMaxAggregateOutputType = {
    commitment: string | null
    revealMessageId: string | null
    salt: string | null
    ica: string | null
    commitmentDispatchTx: string | null
    originDomain: number | null
    createdAt: Date | null
  }

  export type CommitmentCountAggregateOutputType = {
    commitment: number
    revealMessageId: number
    calls: number
    relayers: number
    salt: number
    ica: number
    commitmentDispatchTx: number
    originDomain: number
    createdAt: number
    _all: number
  }


  export type CommitmentAvgAggregateInputType = {
    originDomain?: true
  }

  export type CommitmentSumAggregateInputType = {
    originDomain?: true
  }

  export type CommitmentMinAggregateInputType = {
    commitment?: true
    revealMessageId?: true
    salt?: true
    ica?: true
    commitmentDispatchTx?: true
    originDomain?: true
    createdAt?: true
  }

  export type CommitmentMaxAggregateInputType = {
    commitment?: true
    revealMessageId?: true
    salt?: true
    ica?: true
    commitmentDispatchTx?: true
    originDomain?: true
    createdAt?: true
  }

  export type CommitmentCountAggregateInputType = {
    commitment?: true
    revealMessageId?: true
    calls?: true
    relayers?: true
    salt?: true
    ica?: true
    commitmentDispatchTx?: true
    originDomain?: true
    createdAt?: true
    _all?: true
  }

  export type CommitmentAggregateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Commitment to aggregate.
     */
    where?: CommitmentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Commitments to fetch.
     */
    orderBy?: CommitmentOrderByWithRelationInput | CommitmentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the start position
     */
    cursor?: CommitmentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Commitments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Commitments.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Count returned Commitments
    **/
    _count?: true | CommitmentCountAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to average
    **/
    _avg?: CommitmentAvgAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to sum
    **/
    _sum?: CommitmentSumAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the minimum value
    **/
    _min?: CommitmentMinAggregateInputType
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     * 
     * Select which fields to find the maximum value
    **/
    _max?: CommitmentMaxAggregateInputType
  }

  export type GetCommitmentAggregateType<T extends CommitmentAggregateArgs> = {
        [P in keyof T & keyof AggregateCommitment]: P extends '_count' | 'count'
      ? T[P] extends true
        ? number
        : GetScalarType<T[P], AggregateCommitment[P]>
      : GetScalarType<T[P], AggregateCommitment[P]>
  }




  export type CommitmentGroupByArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    where?: CommitmentWhereInput
    orderBy?: CommitmentOrderByWithAggregationInput | CommitmentOrderByWithAggregationInput[]
    by: CommitmentScalarFieldEnum[] | CommitmentScalarFieldEnum
    having?: CommitmentScalarWhereWithAggregatesInput
    take?: number
    skip?: number
    _count?: CommitmentCountAggregateInputType | true
    _avg?: CommitmentAvgAggregateInputType
    _sum?: CommitmentSumAggregateInputType
    _min?: CommitmentMinAggregateInputType
    _max?: CommitmentMaxAggregateInputType
  }

  export type CommitmentGroupByOutputType = {
    commitment: string
    revealMessageId: string
    calls: JsonValue
    relayers: JsonValue
    salt: string
    ica: string
    commitmentDispatchTx: string
    originDomain: number
    createdAt: Date
    _count: CommitmentCountAggregateOutputType | null
    _avg: CommitmentAvgAggregateOutputType | null
    _sum: CommitmentSumAggregateOutputType | null
    _min: CommitmentMinAggregateOutputType | null
    _max: CommitmentMaxAggregateOutputType | null
  }

  type GetCommitmentGroupByPayload<T extends CommitmentGroupByArgs> = Prisma.PrismaPromise<
    Array<
      PickEnumerable<CommitmentGroupByOutputType, T['by']> &
        {
          [P in ((keyof T) & (keyof CommitmentGroupByOutputType))]: P extends '_count'
            ? T[P] extends boolean
              ? number
              : GetScalarType<T[P], CommitmentGroupByOutputType[P]>
            : GetScalarType<T[P], CommitmentGroupByOutputType[P]>
        }
      >
    >


  export type CommitmentSelect<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    commitment?: boolean
    revealMessageId?: boolean
    calls?: boolean
    relayers?: boolean
    salt?: boolean
    ica?: boolean
    commitmentDispatchTx?: boolean
    originDomain?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["commitment"]>

  export type CommitmentSelectCreateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    commitment?: boolean
    revealMessageId?: boolean
    calls?: boolean
    relayers?: boolean
    salt?: boolean
    ica?: boolean
    commitmentDispatchTx?: boolean
    originDomain?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["commitment"]>

  export type CommitmentSelectUpdateManyAndReturn<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetSelect<{
    commitment?: boolean
    revealMessageId?: boolean
    calls?: boolean
    relayers?: boolean
    salt?: boolean
    ica?: boolean
    commitmentDispatchTx?: boolean
    originDomain?: boolean
    createdAt?: boolean
  }, ExtArgs["result"]["commitment"]>

  export type CommitmentSelectScalar = {
    commitment?: boolean
    revealMessageId?: boolean
    calls?: boolean
    relayers?: boolean
    salt?: boolean
    ica?: boolean
    commitmentDispatchTx?: boolean
    originDomain?: boolean
    createdAt?: boolean
  }

  export type CommitmentOmit<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = $Extensions.GetOmit<"commitment" | "revealMessageId" | "calls" | "relayers" | "salt" | "ica" | "commitmentDispatchTx" | "originDomain" | "createdAt", ExtArgs["result"]["commitment"]>

  export type $CommitmentPayload<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    name: "Commitment"
    objects: {}
    scalars: $Extensions.GetPayloadResult<{
      commitment: string
      revealMessageId: string
      calls: Prisma.JsonValue
      relayers: Prisma.JsonValue
      salt: string
      ica: string
      commitmentDispatchTx: string
      originDomain: number
      createdAt: Date
    }, ExtArgs["result"]["commitment"]>
    composites: {}
  }

  type CommitmentGetPayload<S extends boolean | null | undefined | CommitmentDefaultArgs> = $Result.GetResult<Prisma.$CommitmentPayload, S>

  type CommitmentCountArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> =
    Omit<CommitmentFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
      select?: CommitmentCountAggregateInputType | true
    }

  export interface CommitmentDelegate<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['Commitment'], meta: { name: 'Commitment' } }
    /**
     * Find zero or one Commitment that matches the filter.
     * @param {CommitmentFindUniqueArgs} args - Arguments to find a Commitment
     * @example
     * // Get one Commitment
     * const commitment = await prisma.commitment.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends CommitmentFindUniqueArgs>(args: SelectSubset<T, CommitmentFindUniqueArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find one Commitment that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {CommitmentFindUniqueOrThrowArgs} args - Arguments to find a Commitment
     * @example
     * // Get one Commitment
     * const commitment = await prisma.commitment.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends CommitmentFindUniqueOrThrowArgs>(args: SelectSubset<T, CommitmentFindUniqueOrThrowArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first Commitment that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {CommitmentFindFirstArgs} args - Arguments to find a Commitment
     * @example
     * // Get one Commitment
     * const commitment = await prisma.commitment.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends CommitmentFindFirstArgs>(args?: SelectSubset<T, CommitmentFindFirstArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>

    /**
     * Find the first Commitment that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {CommitmentFindFirstOrThrowArgs} args - Arguments to find a Commitment
     * @example
     * // Get one Commitment
     * const commitment = await prisma.commitment.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends CommitmentFindFirstOrThrowArgs>(args?: SelectSubset<T, CommitmentFindFirstOrThrowArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Find zero or more Commitments that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {CommitmentFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all Commitments
     * const commitments = await prisma.commitment.findMany()
     * 
     * // Get first 10 Commitments
     * const commitments = await prisma.commitment.findMany({ take: 10 })
     * 
     * // Only select the `commitment`
     * const commitmentWithCommitmentOnly = await prisma.commitment.findMany({ select: { commitment: true } })
     * 
     */
    findMany<T extends CommitmentFindManyArgs>(args?: SelectSubset<T, CommitmentFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>

    /**
     * Create a Commitment.
     * @param {CommitmentCreateArgs} args - Arguments to create a Commitment.
     * @example
     * // Create one Commitment
     * const Commitment = await prisma.commitment.create({
     *   data: {
     *     // ... data to create a Commitment
     *   }
     * })
     * 
     */
    create<T extends CommitmentCreateArgs>(args: SelectSubset<T, CommitmentCreateArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Create many Commitments.
     * @param {CommitmentCreateManyArgs} args - Arguments to create many Commitments.
     * @example
     * // Create many Commitments
     * const commitment = await prisma.commitment.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *     
     */
    createMany<T extends CommitmentCreateManyArgs>(args?: SelectSubset<T, CommitmentCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Create many Commitments and returns the data saved in the database.
     * @param {CommitmentCreateManyAndReturnArgs} args - Arguments to create many Commitments.
     * @example
     * // Create many Commitments
     * const commitment = await prisma.commitment.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Create many Commitments and only return the `commitment`
     * const commitmentWithCommitmentOnly = await prisma.commitment.createManyAndReturn({
     *   select: { commitment: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    createManyAndReturn<T extends CommitmentCreateManyAndReturnArgs>(args?: SelectSubset<T, CommitmentCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>

    /**
     * Delete a Commitment.
     * @param {CommitmentDeleteArgs} args - Arguments to delete one Commitment.
     * @example
     * // Delete one Commitment
     * const Commitment = await prisma.commitment.delete({
     *   where: {
     *     // ... filter to delete one Commitment
     *   }
     * })
     * 
     */
    delete<T extends CommitmentDeleteArgs>(args: SelectSubset<T, CommitmentDeleteArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Update one Commitment.
     * @param {CommitmentUpdateArgs} args - Arguments to update one Commitment.
     * @example
     * // Update one Commitment
     * const commitment = await prisma.commitment.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    update<T extends CommitmentUpdateArgs>(args: SelectSubset<T, CommitmentUpdateArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>

    /**
     * Delete zero or more Commitments.
     * @param {CommitmentDeleteManyArgs} args - Arguments to filter Commitments to delete.
     * @example
     * // Delete a few Commitments
     * const { count } = await prisma.commitment.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     * 
     */
    deleteMany<T extends CommitmentDeleteManyArgs>(args?: SelectSubset<T, CommitmentDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more Commitments.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {CommitmentUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many Commitments
     * const commitment = await prisma.commitment.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     * 
     */
    updateMany<T extends CommitmentUpdateManyArgs>(args: SelectSubset<T, CommitmentUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<BatchPayload>

    /**
     * Update zero or more Commitments and returns the data updated in the database.
     * @param {CommitmentUpdateManyAndReturnArgs} args - Arguments to update many Commitments.
     * @example
     * // Update many Commitments
     * const commitment = await prisma.commitment.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * 
     * // Update zero or more Commitments and only return the `commitment`
     * const commitmentWithCommitmentOnly = await prisma.commitment.updateManyAndReturn({
     *   select: { commitment: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * 
     */
    updateManyAndReturn<T extends CommitmentUpdateManyAndReturnArgs>(args: SelectSubset<T, CommitmentUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>

    /**
     * Create or update one Commitment.
     * @param {CommitmentUpsertArgs} args - Arguments to update or create a Commitment.
     * @example
     * // Update or create a Commitment
     * const commitment = await prisma.commitment.upsert({
     *   create: {
     *     // ... data to create a Commitment
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the Commitment we want to update
     *   }
     * })
     */
    upsert<T extends CommitmentUpsertArgs>(args: SelectSubset<T, CommitmentUpsertArgs<ExtArgs>>): Prisma__CommitmentClient<$Result.GetResult<Prisma.$CommitmentPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>


    /**
     * Count the number of Commitments.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {CommitmentCountArgs} args - Arguments to filter Commitments to count.
     * @example
     * // Count the number of Commitments
     * const count = await prisma.commitment.count({
     *   where: {
     *     // ... the filter for the Commitments we want to count
     *   }
     * })
    **/
    count<T extends CommitmentCountArgs>(
      args?: Subset<T, CommitmentCountArgs>,
    ): Prisma.PrismaPromise<
      T extends $Utils.Record<'select', any>
        ? T['select'] extends true
          ? number
          : GetScalarType<T['select'], CommitmentCountAggregateOutputType>
        : number
    >

    /**
     * Allows you to perform aggregations operations on a Commitment.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {CommitmentAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends CommitmentAggregateArgs>(args: Subset<T, CommitmentAggregateArgs>): Prisma.PrismaPromise<GetCommitmentAggregateType<T>>

    /**
     * Group by Commitment.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {CommitmentGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     * 
    **/
    groupBy<
      T extends CommitmentGroupByArgs,
      HasSelectOrTake extends Or<
        Extends<'skip', Keys<T>>,
        Extends<'take', Keys<T>>
      >,
      OrderByArg extends True extends HasSelectOrTake
        ? { orderBy: CommitmentGroupByArgs['orderBy'] }
        : { orderBy?: CommitmentGroupByArgs['orderBy'] },
      OrderFields extends ExcludeUnderscoreKeys<Keys<MaybeTupleToUnion<T['orderBy']>>>,
      ByFields extends MaybeTupleToUnion<T['by']>,
      ByValid extends Has<ByFields, OrderFields>,
      HavingFields extends GetHavingFields<T['having']>,
      HavingValid extends Has<ByFields, HavingFields>,
      ByEmpty extends T['by'] extends never[] ? True : False,
      InputErrors extends ByEmpty extends True
      ? `Error: "by" must not be empty.`
      : HavingValid extends False
      ? {
          [P in HavingFields]: P extends ByFields
            ? never
            : P extends string
            ? `Error: Field "${P}" used in "having" needs to be provided in "by".`
            : [
                Error,
                'Field ',
                P,
                ` in "having" needs to be provided in "by"`,
              ]
        }[HavingFields]
      : 'take' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "take", you also need to provide "orderBy"'
      : 'skip' extends Keys<T>
      ? 'orderBy' extends Keys<T>
        ? ByValid extends True
          ? {}
          : {
              [P in OrderFields]: P extends ByFields
                ? never
                : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
            }[OrderFields]
        : 'Error: If you provide "skip", you also need to provide "orderBy"'
      : ByValid extends True
      ? {}
      : {
          [P in OrderFields]: P extends ByFields
            ? never
            : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`
        }[OrderFields]
    >(args: SubsetIntersection<T, CommitmentGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetCommitmentGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>
  /**
   * Fields of the Commitment model
   */
  readonly fields: CommitmentFieldRefs;
  }

  /**
   * The delegate class that acts as a "Promise-like" for Commitment.
   * Why is this prefixed with `Prisma__`?
   * Because we want to prevent naming conflicts as mentioned in
   * https://github.com/prisma/prisma-client-js/issues/707
   */
  export interface Prisma__CommitmentClient<T, Null = never, ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise"
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): $Utils.JsPromise<TResult1 | TResult2>
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): $Utils.JsPromise<T | TResult>
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): $Utils.JsPromise<T>
  }




  /**
   * Fields of the Commitment model
   */
  interface CommitmentFieldRefs {
    readonly commitment: FieldRef<"Commitment", 'String'>
    readonly revealMessageId: FieldRef<"Commitment", 'String'>
    readonly calls: FieldRef<"Commitment", 'Json'>
    readonly relayers: FieldRef<"Commitment", 'Json'>
    readonly salt: FieldRef<"Commitment", 'String'>
    readonly ica: FieldRef<"Commitment", 'String'>
    readonly commitmentDispatchTx: FieldRef<"Commitment", 'String'>
    readonly originDomain: FieldRef<"Commitment", 'Int'>
    readonly createdAt: FieldRef<"Commitment", 'DateTime'>
  }
    

  // Custom InputTypes
  /**
   * Commitment findUnique
   */
  export type CommitmentFindUniqueArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * Filter, which Commitment to fetch.
     */
    where: CommitmentWhereUniqueInput
  }

  /**
   * Commitment findUniqueOrThrow
   */
  export type CommitmentFindUniqueOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * Filter, which Commitment to fetch.
     */
    where: CommitmentWhereUniqueInput
  }

  /**
   * Commitment findFirst
   */
  export type CommitmentFindFirstArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * Filter, which Commitment to fetch.
     */
    where?: CommitmentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Commitments to fetch.
     */
    orderBy?: CommitmentOrderByWithRelationInput | CommitmentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Commitments.
     */
    cursor?: CommitmentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Commitments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Commitments.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Commitments.
     */
    distinct?: CommitmentScalarFieldEnum | CommitmentScalarFieldEnum[]
  }

  /**
   * Commitment findFirstOrThrow
   */
  export type CommitmentFindFirstOrThrowArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * Filter, which Commitment to fetch.
     */
    where?: CommitmentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Commitments to fetch.
     */
    orderBy?: CommitmentOrderByWithRelationInput | CommitmentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for searching for Commitments.
     */
    cursor?: CommitmentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Commitments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Commitments.
     */
    skip?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     * 
     * Filter by unique combinations of Commitments.
     */
    distinct?: CommitmentScalarFieldEnum | CommitmentScalarFieldEnum[]
  }

  /**
   * Commitment findMany
   */
  export type CommitmentFindManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * Filter, which Commitments to fetch.
     */
    where?: CommitmentWhereInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     * 
     * Determine the order of Commitments to fetch.
     */
    orderBy?: CommitmentOrderByWithRelationInput | CommitmentOrderByWithRelationInput[]
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     * 
     * Sets the position for listing Commitments.
     */
    cursor?: CommitmentWhereUniqueInput
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Take `±n` Commitments from the position of the cursor.
     */
    take?: number
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     * 
     * Skip the first `n` Commitments.
     */
    skip?: number
    distinct?: CommitmentScalarFieldEnum | CommitmentScalarFieldEnum[]
  }

  /**
   * Commitment create
   */
  export type CommitmentCreateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * The data needed to create a Commitment.
     */
    data: XOR<CommitmentCreateInput, CommitmentUncheckedCreateInput>
  }

  /**
   * Commitment createMany
   */
  export type CommitmentCreateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to create many Commitments.
     */
    data: CommitmentCreateManyInput | CommitmentCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Commitment createManyAndReturn
   */
  export type CommitmentCreateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelectCreateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * The data used to create many Commitments.
     */
    data: CommitmentCreateManyInput | CommitmentCreateManyInput[]
    skipDuplicates?: boolean
  }

  /**
   * Commitment update
   */
  export type CommitmentUpdateArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * The data needed to update a Commitment.
     */
    data: XOR<CommitmentUpdateInput, CommitmentUncheckedUpdateInput>
    /**
     * Choose, which Commitment to update.
     */
    where: CommitmentWhereUniqueInput
  }

  /**
   * Commitment updateMany
   */
  export type CommitmentUpdateManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * The data used to update Commitments.
     */
    data: XOR<CommitmentUpdateManyMutationInput, CommitmentUncheckedUpdateManyInput>
    /**
     * Filter which Commitments to update
     */
    where?: CommitmentWhereInput
    /**
     * Limit how many Commitments to update.
     */
    limit?: number
  }

  /**
   * Commitment updateManyAndReturn
   */
  export type CommitmentUpdateManyAndReturnArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelectUpdateManyAndReturn<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * The data used to update Commitments.
     */
    data: XOR<CommitmentUpdateManyMutationInput, CommitmentUncheckedUpdateManyInput>
    /**
     * Filter which Commitments to update
     */
    where?: CommitmentWhereInput
    /**
     * Limit how many Commitments to update.
     */
    limit?: number
  }

  /**
   * Commitment upsert
   */
  export type CommitmentUpsertArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * The filter to search for the Commitment to update in case it exists.
     */
    where: CommitmentWhereUniqueInput
    /**
     * In case the Commitment found by the `where` argument doesn't exist, create a new Commitment with this data.
     */
    create: XOR<CommitmentCreateInput, CommitmentUncheckedCreateInput>
    /**
     * In case the Commitment was found with the provided `where` argument, update it with this data.
     */
    update: XOR<CommitmentUpdateInput, CommitmentUncheckedUpdateInput>
  }

  /**
   * Commitment delete
   */
  export type CommitmentDeleteArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
    /**
     * Filter which Commitment to delete.
     */
    where: CommitmentWhereUniqueInput
  }

  /**
   * Commitment deleteMany
   */
  export type CommitmentDeleteManyArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Filter which Commitments to delete
     */
    where?: CommitmentWhereInput
    /**
     * Limit how many Commitments to delete.
     */
    limit?: number
  }

  /**
   * Commitment without action
   */
  export type CommitmentDefaultArgs<ExtArgs extends $Extensions.InternalArgs = $Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the Commitment
     */
    select?: CommitmentSelect<ExtArgs> | null
    /**
     * Omit specific fields from the Commitment
     */
    omit?: CommitmentOmit<ExtArgs> | null
  }


  /**
   * Enums
   */

  export const TransactionIsolationLevel: {
    ReadUncommitted: 'ReadUncommitted',
    ReadCommitted: 'ReadCommitted',
    RepeatableRead: 'RepeatableRead',
    Serializable: 'Serializable'
  };

  export type TransactionIsolationLevel = (typeof TransactionIsolationLevel)[keyof typeof TransactionIsolationLevel]


  export const CommitmentScalarFieldEnum: {
    commitment: 'commitment',
    revealMessageId: 'revealMessageId',
    calls: 'calls',
    relayers: 'relayers',
    salt: 'salt',
    ica: 'ica',
    commitmentDispatchTx: 'commitmentDispatchTx',
    originDomain: 'originDomain',
    createdAt: 'createdAt'
  };

  export type CommitmentScalarFieldEnum = (typeof CommitmentScalarFieldEnum)[keyof typeof CommitmentScalarFieldEnum]


  export const SortOrder: {
    asc: 'asc',
    desc: 'desc'
  };

  export type SortOrder = (typeof SortOrder)[keyof typeof SortOrder]


  export const JsonNullValueInput: {
    JsonNull: typeof JsonNull
  };

  export type JsonNullValueInput = (typeof JsonNullValueInput)[keyof typeof JsonNullValueInput]


  export const QueryMode: {
    default: 'default',
    insensitive: 'insensitive'
  };

  export type QueryMode = (typeof QueryMode)[keyof typeof QueryMode]


  export const JsonNullValueFilter: {
    DbNull: typeof DbNull,
    JsonNull: typeof JsonNull,
    AnyNull: typeof AnyNull
  };

  export type JsonNullValueFilter = (typeof JsonNullValueFilter)[keyof typeof JsonNullValueFilter]


  /**
   * Field references
   */


  /**
   * Reference to a field of type 'String'
   */
  export type StringFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'String'>
    


  /**
   * Reference to a field of type 'String[]'
   */
  export type ListStringFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'String[]'>
    


  /**
   * Reference to a field of type 'Json'
   */
  export type JsonFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Json'>
    


  /**
   * Reference to a field of type 'QueryMode'
   */
  export type EnumQueryModeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'QueryMode'>
    


  /**
   * Reference to a field of type 'Int'
   */
  export type IntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Int'>
    


  /**
   * Reference to a field of type 'Int[]'
   */
  export type ListIntFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Int[]'>
    


  /**
   * Reference to a field of type 'DateTime'
   */
  export type DateTimeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'DateTime'>
    


  /**
   * Reference to a field of type 'DateTime[]'
   */
  export type ListDateTimeFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'DateTime[]'>
    


  /**
   * Reference to a field of type 'Float'
   */
  export type FloatFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Float'>
    


  /**
   * Reference to a field of type 'Float[]'
   */
  export type ListFloatFieldRefInput<$PrismaModel> = FieldRefInputType<$PrismaModel, 'Float[]'>
    
  /**
   * Deep Input Types
   */


  export type CommitmentWhereInput = {
    AND?: CommitmentWhereInput | CommitmentWhereInput[]
    OR?: CommitmentWhereInput[]
    NOT?: CommitmentWhereInput | CommitmentWhereInput[]
    commitment?: StringFilter<"Commitment"> | string
    revealMessageId?: StringFilter<"Commitment"> | string
    calls?: JsonFilter<"Commitment">
    relayers?: JsonFilter<"Commitment">
    salt?: StringFilter<"Commitment"> | string
    ica?: StringFilter<"Commitment"> | string
    commitmentDispatchTx?: StringFilter<"Commitment"> | string
    originDomain?: IntFilter<"Commitment"> | number
    createdAt?: DateTimeFilter<"Commitment"> | Date | string
  }

  export type CommitmentOrderByWithRelationInput = {
    commitment?: SortOrder
    revealMessageId?: SortOrder
    calls?: SortOrder
    relayers?: SortOrder
    salt?: SortOrder
    ica?: SortOrder
    commitmentDispatchTx?: SortOrder
    originDomain?: SortOrder
    createdAt?: SortOrder
  }

  export type CommitmentWhereUniqueInput = Prisma.AtLeast<{
    revealMessageId?: string
    AND?: CommitmentWhereInput | CommitmentWhereInput[]
    OR?: CommitmentWhereInput[]
    NOT?: CommitmentWhereInput | CommitmentWhereInput[]
    commitment?: StringFilter<"Commitment"> | string
    calls?: JsonFilter<"Commitment">
    relayers?: JsonFilter<"Commitment">
    salt?: StringFilter<"Commitment"> | string
    ica?: StringFilter<"Commitment"> | string
    commitmentDispatchTx?: StringFilter<"Commitment"> | string
    originDomain?: IntFilter<"Commitment"> | number
    createdAt?: DateTimeFilter<"Commitment"> | Date | string
  }, "revealMessageId">

  export type CommitmentOrderByWithAggregationInput = {
    commitment?: SortOrder
    revealMessageId?: SortOrder
    calls?: SortOrder
    relayers?: SortOrder
    salt?: SortOrder
    ica?: SortOrder
    commitmentDispatchTx?: SortOrder
    originDomain?: SortOrder
    createdAt?: SortOrder
    _count?: CommitmentCountOrderByAggregateInput
    _avg?: CommitmentAvgOrderByAggregateInput
    _max?: CommitmentMaxOrderByAggregateInput
    _min?: CommitmentMinOrderByAggregateInput
    _sum?: CommitmentSumOrderByAggregateInput
  }

  export type CommitmentScalarWhereWithAggregatesInput = {
    AND?: CommitmentScalarWhereWithAggregatesInput | CommitmentScalarWhereWithAggregatesInput[]
    OR?: CommitmentScalarWhereWithAggregatesInput[]
    NOT?: CommitmentScalarWhereWithAggregatesInput | CommitmentScalarWhereWithAggregatesInput[]
    commitment?: StringWithAggregatesFilter<"Commitment"> | string
    revealMessageId?: StringWithAggregatesFilter<"Commitment"> | string
    calls?: JsonWithAggregatesFilter<"Commitment">
    relayers?: JsonWithAggregatesFilter<"Commitment">
    salt?: StringWithAggregatesFilter<"Commitment"> | string
    ica?: StringWithAggregatesFilter<"Commitment"> | string
    commitmentDispatchTx?: StringWithAggregatesFilter<"Commitment"> | string
    originDomain?: IntWithAggregatesFilter<"Commitment"> | number
    createdAt?: DateTimeWithAggregatesFilter<"Commitment"> | Date | string
  }

  export type CommitmentCreateInput = {
    commitment: string
    revealMessageId: string
    calls: JsonNullValueInput | InputJsonValue
    relayers: JsonNullValueInput | InputJsonValue
    salt: string
    ica: string
    commitmentDispatchTx: string
    originDomain: number
    createdAt?: Date | string
  }

  export type CommitmentUncheckedCreateInput = {
    commitment: string
    revealMessageId: string
    calls: JsonNullValueInput | InputJsonValue
    relayers: JsonNullValueInput | InputJsonValue
    salt: string
    ica: string
    commitmentDispatchTx: string
    originDomain: number
    createdAt?: Date | string
  }

  export type CommitmentUpdateInput = {
    commitment?: StringFieldUpdateOperationsInput | string
    revealMessageId?: StringFieldUpdateOperationsInput | string
    calls?: JsonNullValueInput | InputJsonValue
    relayers?: JsonNullValueInput | InputJsonValue
    salt?: StringFieldUpdateOperationsInput | string
    ica?: StringFieldUpdateOperationsInput | string
    commitmentDispatchTx?: StringFieldUpdateOperationsInput | string
    originDomain?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type CommitmentUncheckedUpdateInput = {
    commitment?: StringFieldUpdateOperationsInput | string
    revealMessageId?: StringFieldUpdateOperationsInput | string
    calls?: JsonNullValueInput | InputJsonValue
    relayers?: JsonNullValueInput | InputJsonValue
    salt?: StringFieldUpdateOperationsInput | string
    ica?: StringFieldUpdateOperationsInput | string
    commitmentDispatchTx?: StringFieldUpdateOperationsInput | string
    originDomain?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type CommitmentCreateManyInput = {
    commitment: string
    revealMessageId: string
    calls: JsonNullValueInput | InputJsonValue
    relayers: JsonNullValueInput | InputJsonValue
    salt: string
    ica: string
    commitmentDispatchTx: string
    originDomain: number
    createdAt?: Date | string
  }

  export type CommitmentUpdateManyMutationInput = {
    commitment?: StringFieldUpdateOperationsInput | string
    revealMessageId?: StringFieldUpdateOperationsInput | string
    calls?: JsonNullValueInput | InputJsonValue
    relayers?: JsonNullValueInput | InputJsonValue
    salt?: StringFieldUpdateOperationsInput | string
    ica?: StringFieldUpdateOperationsInput | string
    commitmentDispatchTx?: StringFieldUpdateOperationsInput | string
    originDomain?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type CommitmentUncheckedUpdateManyInput = {
    commitment?: StringFieldUpdateOperationsInput | string
    revealMessageId?: StringFieldUpdateOperationsInput | string
    calls?: JsonNullValueInput | InputJsonValue
    relayers?: JsonNullValueInput | InputJsonValue
    salt?: StringFieldUpdateOperationsInput | string
    ica?: StringFieldUpdateOperationsInput | string
    commitmentDispatchTx?: StringFieldUpdateOperationsInput | string
    originDomain?: IntFieldUpdateOperationsInput | number
    createdAt?: DateTimeFieldUpdateOperationsInput | Date | string
  }

  export type StringFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringFilter<$PrismaModel> | string
  }
  export type JsonFilter<$PrismaModel = never> =
    | PatchUndefined<
        Either<Required<JsonFilterBase<$PrismaModel>>, Exclude<keyof Required<JsonFilterBase<$PrismaModel>>, 'path'>>,
        Required<JsonFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<JsonFilterBase<$PrismaModel>>, 'path'>>

  export type JsonFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    mode?: QueryMode | EnumQueryModeFieldRefInput<$PrismaModel>
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
  }

  export type IntFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntFilter<$PrismaModel> | number
  }

  export type DateTimeFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeFilter<$PrismaModel> | Date | string
  }

  export type CommitmentCountOrderByAggregateInput = {
    commitment?: SortOrder
    revealMessageId?: SortOrder
    calls?: SortOrder
    relayers?: SortOrder
    salt?: SortOrder
    ica?: SortOrder
    commitmentDispatchTx?: SortOrder
    originDomain?: SortOrder
    createdAt?: SortOrder
  }

  export type CommitmentAvgOrderByAggregateInput = {
    originDomain?: SortOrder
  }

  export type CommitmentMaxOrderByAggregateInput = {
    commitment?: SortOrder
    revealMessageId?: SortOrder
    salt?: SortOrder
    ica?: SortOrder
    commitmentDispatchTx?: SortOrder
    originDomain?: SortOrder
    createdAt?: SortOrder
  }

  export type CommitmentMinOrderByAggregateInput = {
    commitment?: SortOrder
    revealMessageId?: SortOrder
    salt?: SortOrder
    ica?: SortOrder
    commitmentDispatchTx?: SortOrder
    originDomain?: SortOrder
    createdAt?: SortOrder
  }

  export type CommitmentSumOrderByAggregateInput = {
    originDomain?: SortOrder
  }

  export type StringWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    mode?: QueryMode
    not?: NestedStringWithAggregatesFilter<$PrismaModel> | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedStringFilter<$PrismaModel>
    _max?: NestedStringFilter<$PrismaModel>
  }
  export type JsonWithAggregatesFilter<$PrismaModel = never> =
    | PatchUndefined<
        Either<Required<JsonWithAggregatesFilterBase<$PrismaModel>>, Exclude<keyof Required<JsonWithAggregatesFilterBase<$PrismaModel>>, 'path'>>,
        Required<JsonWithAggregatesFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<JsonWithAggregatesFilterBase<$PrismaModel>>, 'path'>>

  export type JsonWithAggregatesFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    mode?: QueryMode | EnumQueryModeFieldRefInput<$PrismaModel>
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedJsonFilter<$PrismaModel>
    _max?: NestedJsonFilter<$PrismaModel>
  }

  export type IntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntWithAggregatesFilter<$PrismaModel> | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedIntFilter<$PrismaModel>
    _min?: NestedIntFilter<$PrismaModel>
    _max?: NestedIntFilter<$PrismaModel>
  }

  export type DateTimeWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeWithAggregatesFilter<$PrismaModel> | Date | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedDateTimeFilter<$PrismaModel>
    _max?: NestedDateTimeFilter<$PrismaModel>
  }

  export type StringFieldUpdateOperationsInput = {
    set?: string
  }

  export type IntFieldUpdateOperationsInput = {
    set?: number
    increment?: number
    decrement?: number
    multiply?: number
    divide?: number
  }

  export type DateTimeFieldUpdateOperationsInput = {
    set?: Date | string
  }

  export type NestedStringFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringFilter<$PrismaModel> | string
  }

  export type NestedIntFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntFilter<$PrismaModel> | number
  }

  export type NestedDateTimeFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeFilter<$PrismaModel> | Date | string
  }

  export type NestedStringWithAggregatesFilter<$PrismaModel = never> = {
    equals?: string | StringFieldRefInput<$PrismaModel>
    in?: string[] | ListStringFieldRefInput<$PrismaModel>
    notIn?: string[] | ListStringFieldRefInput<$PrismaModel>
    lt?: string | StringFieldRefInput<$PrismaModel>
    lte?: string | StringFieldRefInput<$PrismaModel>
    gt?: string | StringFieldRefInput<$PrismaModel>
    gte?: string | StringFieldRefInput<$PrismaModel>
    contains?: string | StringFieldRefInput<$PrismaModel>
    startsWith?: string | StringFieldRefInput<$PrismaModel>
    endsWith?: string | StringFieldRefInput<$PrismaModel>
    not?: NestedStringWithAggregatesFilter<$PrismaModel> | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedStringFilter<$PrismaModel>
    _max?: NestedStringFilter<$PrismaModel>
  }
  export type NestedJsonFilter<$PrismaModel = never> =
    | PatchUndefined<
        Either<Required<NestedJsonFilterBase<$PrismaModel>>, Exclude<keyof Required<NestedJsonFilterBase<$PrismaModel>>, 'path'>>,
        Required<NestedJsonFilterBase<$PrismaModel>>
      >
    | OptionalFlat<Omit<Required<NestedJsonFilterBase<$PrismaModel>>, 'path'>>

  export type NestedJsonFilterBase<$PrismaModel = never> = {
    equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
    path?: string[]
    mode?: QueryMode | EnumQueryModeFieldRefInput<$PrismaModel>
    string_contains?: string | StringFieldRefInput<$PrismaModel>
    string_starts_with?: string | StringFieldRefInput<$PrismaModel>
    string_ends_with?: string | StringFieldRefInput<$PrismaModel>
    array_starts_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_ends_with?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    array_contains?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | null
    lt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    lte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gt?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    gte?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
    not?: InputJsonValue | JsonFieldRefInput<$PrismaModel> | JsonNullValueFilter
  }

  export type NestedIntWithAggregatesFilter<$PrismaModel = never> = {
    equals?: number | IntFieldRefInput<$PrismaModel>
    in?: number[] | ListIntFieldRefInput<$PrismaModel>
    notIn?: number[] | ListIntFieldRefInput<$PrismaModel>
    lt?: number | IntFieldRefInput<$PrismaModel>
    lte?: number | IntFieldRefInput<$PrismaModel>
    gt?: number | IntFieldRefInput<$PrismaModel>
    gte?: number | IntFieldRefInput<$PrismaModel>
    not?: NestedIntWithAggregatesFilter<$PrismaModel> | number
    _count?: NestedIntFilter<$PrismaModel>
    _avg?: NestedFloatFilter<$PrismaModel>
    _sum?: NestedIntFilter<$PrismaModel>
    _min?: NestedIntFilter<$PrismaModel>
    _max?: NestedIntFilter<$PrismaModel>
  }

  export type NestedFloatFilter<$PrismaModel = never> = {
    equals?: number | FloatFieldRefInput<$PrismaModel>
    in?: number[] | ListFloatFieldRefInput<$PrismaModel>
    notIn?: number[] | ListFloatFieldRefInput<$PrismaModel>
    lt?: number | FloatFieldRefInput<$PrismaModel>
    lte?: number | FloatFieldRefInput<$PrismaModel>
    gt?: number | FloatFieldRefInput<$PrismaModel>
    gte?: number | FloatFieldRefInput<$PrismaModel>
    not?: NestedFloatFilter<$PrismaModel> | number
  }

  export type NestedDateTimeWithAggregatesFilter<$PrismaModel = never> = {
    equals?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    in?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    notIn?: Date[] | string[] | ListDateTimeFieldRefInput<$PrismaModel>
    lt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    lte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gt?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    gte?: Date | string | DateTimeFieldRefInput<$PrismaModel>
    not?: NestedDateTimeWithAggregatesFilter<$PrismaModel> | Date | string
    _count?: NestedIntFilter<$PrismaModel>
    _min?: NestedDateTimeFilter<$PrismaModel>
    _max?: NestedDateTimeFilter<$PrismaModel>
  }



  /**
   * Batch Payload for updateMany & deleteMany & createMany
   */

  export type BatchPayload = {
    count: number
  }

  /**
   * DMMF
   */
  export const dmmf: runtime.BaseDMMF
}