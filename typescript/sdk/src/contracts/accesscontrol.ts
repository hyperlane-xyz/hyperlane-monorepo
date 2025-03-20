import { BaseContract } from 'ethers';

export type Access<Role> = {
  authorized: Set<Role>;
  guardian: Role;
  delay: number;
};

export type AccessManaged<C extends BaseContract, Role> = Partial<
  Record<keyof C['interface']['functions'], Access<Role>>
>;
