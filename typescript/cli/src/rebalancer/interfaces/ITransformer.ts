export interface ITransformer<T, R> {
  transform(from: T): R;
}
