// Destination (§3, section 1's table): where a reference made on a host, or a hold arriving on one of its links, goes:
// here, over the route of its host address, or over the parent link; and the check that an object served here lives
// here.

import type { Context } from "../../context/index.ts";
import type { Address, Contract, ParamsOf } from "../contracts/index.ts";
import { contractData } from "../contracts/internal.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { WireAddress } from "../link/internal.ts";
import type { HoldRequest, HostLink, Path } from "../remote/internal.ts";
import type { Served } from "./object.ts";
import type { Route } from "./route.ts";

/** Where something is placed: here, or over a path (with the host address it was computed or named with). */
export type Placed =
	| { readonly kind: "here" }
	| { readonly kind: "path"; readonly path: Path; readonly address: WireAddress };

/** A host's destinations: its address, its served types, its routes and its parent path, as the host keeps them. */
export class Destination {
	readonly #address: Address | undefined;
	readonly #types: ReadonlyMap<string, Served>;
	readonly #routes: ReadonlyMap<string, Route>;
	readonly #parent: Path;

	constructor(
		address: Address | undefined,
		types: ReadonlyMap<string, Served>,
		routes: ReadonlyMap<string, Route>,
		parent: Path,
	) {
		this.#address = address;
		this.#types = types;
		this.#routes = routes;
		this.#parent = parent;
	}

	/**
	 * Where a reference to `Type` with `params` made as `principal` goes: here for a local type (served here: the host
	 * refused it otherwise) or a remote type served here whose host address is this host's; otherwise over the route of
	 * its host address's kind, or over the parent link (the host address decides where an object lives: a worker
	 * reaches another worker's object of a type it serves too). Throws `invalid/host_address` for a host address whose
	 * params do not fit its kind, `forbidden` when the route refuses, and what a `hostAddress` or `authorize` throws.
	 */
	reference(Type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined, context: Context): Placed {
		if (Type.kind === "local") return HERE;
		const address = hostAddressOf(Type, params);
		if (this.#types.has(Type.name) && this.#isHere(address)) return HERE;
		return { kind: "path", path: this.#pathTo(address, principal, context) ?? this.#parent, address };
	}

	/**
	 * Where a hold arriving on `link` acting as `principal` goes: here when its type is served here; over the route of
	 * the address it names; else over the parent link (waiting for it while it is down), unless it came on the parent
	 * link or this host never had one (`unavailable`). Throws as `reference` does.
	 */
	hold(request: HoldRequest, link: HostLink, principal: Principal | undefined, context: Context): Placed {
		if (this.#types.has(request.type)) return HERE;
		const { address } = request;
		const routed = this.#pathTo(address, principal, context);
		if (routed !== undefined) return { kind: "path", path: routed, address };
		if (link.role === "parent" || !this.#parent.linked) {
			throw new ChordError({ code: "unavailable", message: `${request.type} is not served here` });
		}
		return { kind: "path", path: this.#parent, address };
	}

	/**
	 * Throws `invalid/host_address` for a hold of `Type` with `params` (checked) served here but whose host address is
	 * another host (misrouted; never forwarded). The host address is computed here from the params: the address a hold
	 * names only routes it.
	 */
	assertHere(Type: Contract, params: ParamsOf<Contract>): void {
		const address = hostAddressOf(Type, params);
		if (this.#isHere(address)) return;
		// A host serving a remote type has an address (`serve` refuses one without).
		throw invalid("host_address", `${Type.name}: placed on ${address.kind}, this host is ${this.#address!.key}`);
	}

	/**
	 * The path to `address` when this host routes its kind (its params checked, `authorize` run for `principal`);
	 * `undefined` without a route for its kind.
	 */
	#pathTo(address: WireAddress, principal: Principal | undefined, context: Context): Path | undefined {
		return this.#routes.get(address.kind)?.path(address.params, principal, context);
	}

	/** Whether an object whose host address is `address` lives here: this host has that address. */
	#isHere(address: WireAddress): boolean {
		const own = this.#address;
		return own !== undefined && sameAddress(own, address);
	}
}

const HERE: Placed = { kind: "here" };

/** The address a remote `Type`'s `hostAddress` computes for `params`. */
function hostAddressOf(Type: Contract, params: ParamsOf<Contract>): WireAddress {
	// Every remote contract has one (declaration policy, `remote`).
	const hostAddress = contractData(Type).hostAddress!;
	// Plugin code: what it returns is checked where it is routed or served.
	const { kind, params: values } = hostAddress(params) as { readonly kind: string; readonly params: unknown };
	return { kind, params: values };
}

/** Whether `address` names the host at `own`: the same kind and the same value for each of its params. */
function sameAddress(own: Address, address: WireAddress): boolean {
	if (own.kind !== address.kind || typeof address.params !== "object" || address.params === null) return false;
	const values = address.params as { readonly [field: string]: unknown };
	const fields = Object.keys(own.params);
	return Object.keys(values).length === fields.length && fields.every((field) => values[field] === own.params[field]);
}
