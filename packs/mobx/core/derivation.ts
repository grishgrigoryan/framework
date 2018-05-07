import { isProduction } from '../env';
import { IDerivationState } from './IDerivationState';
import { IObservable, IDepTreeNode, addObserver, removeObserver } from "./observable"
import { IAtom } from "./atom"
import { globalState } from "./globalstate"
import { fail } from "../utils/utils"
import { isComputedValue } from "./computedvalue"

export {IDerivationState}

export enum TraceMode {
    NONE,
    LOG,
    BREAK
}

/**
 * A derivation is everything that can be derived from the state (all the atoms) in a pure manner.
 * See https://medium.com/@mweststrate/becoming-fully-reactive-an-in-depth-explanation-of-mobservable-55995262a254#.xvbh6qd74
 */
export interface IDerivation extends IDepTreeNode {
    observing: IObservable[]
    newObserving: null | IObservable[]
    dependenciesState: IDerivationState
    /**
     * Id of the current run of a derivation. Each time the derivation is tracked
     * this number is increased by one. This number is globally unique
     */
    runId: number
    /**
     * amount of dependencies used by the derivation in this run, which has not been bound yet.
     */
    unboundDepsCount: number
    __mapid: string
    onBecomeStale(): void
    isTracing: TraceMode
}

export class CaughtException {
    constructor(public cause: any) {
        // Empty
    }
}

export function isCaughtException(e: any): e is CaughtException {
    return e instanceof CaughtException
}

/**
 * Finds out whether any dependency of the derivation has actually changed.
 * If dependenciesState is 1 then it will recalculate dependencies,
 * if any dependency changed it will propagate it by changing dependenciesState to 2.
 *
 * By iterating over the dependencies in the same order that they were reported and
 * stopping on the first change, all the recalculations are only called for ComputedValues
 * that will be tracked by derivation. That is because we assume that if the first x
 * dependencies of the derivation doesn't change then the derivation should run the same way
 * up until accessing x-th dependency.
 */
export function shouldCompute(derivation: IDerivation): boolean {
    switch (derivation.dependenciesState) {
        case IDerivationState.UP_TO_DATE:
            return false;
        case IDerivationState.NOT_TRACKING:
        case IDerivationState.STALE:
            return true;
        case IDerivationState.POSSIBLY_STALE: {
            const prevUntracked = untrackedStart(); // no need for those computeds to be reported, they will be picked up in trackDerivedFunction.
            const obs = derivation.observing,
                l = obs.length;
            for (let i = 0; i < l; i++) {
                const obj = obs[ i ];
                if (isComputedValue(obj)) {
                    if (globalState.disableErrorBoundaries) {
                        obj.get()
                    } else {
                        try {
                            obj.get()
                        } catch (e) {
                            // we are not interested in the value *or* exception at this moment, but if there is one, notify all
                            untrackedEnd(prevUntracked);
                            return true
                        }
                    }
                    // if ComputedValue `obj` actually changed it will be computed and propagated to its observers.
                    // and `derivation` is an observer of `obj`
                    if ((derivation as any).dependenciesState === IDerivationState.STALE) {
                        untrackedEnd(prevUntracked);
                        return true
                    }
                }
            }
            changeDependenciesStateTo0(derivation);
            untrackedEnd(prevUntracked);
            return false
        }
    }
}

export function isComputingDerivation() {
    return globalState.trackingDerivation !== null // filter out actions inside computations
}

export function checkIfStateModificationsAreAllowed(atom: IAtom) {
    const hasObservers = atom.observers.length > 0;
    // Should never be possible to change an observed observable from inside computed, see #798
    if (globalState.computationDepth > 0 && hasObservers) {
        fail(
            !isProduction &&
            `Computed values are not allowed to cause side effects by changing observables that are already being observed. Tried to modify: ${atom.name}`
        )
    }
    // Should not be possible to change observed state outside strict mode, except during initialization, see #563
    if (!globalState.allowStateChanges && (hasObservers || globalState.enforceActions === "strict")) {
        fail(
            !isProduction &&
            (globalState.enforceActions
                ? "Since strict-mode is enabled, changing observed observable values outside actions is not allowed. Please wrap the code in an `action` if this change is intended. Tried to modify: "
                : "Side effects like changing state are not allowed at this point. Are you trying to modify state from, for example, the render function of a React component? Tried to modify: ") +
            atom.name
        )
    }
}

/**
 * Executes the provided function `f` and tracks which observables are being accessed.
 * The tracking information is stored on the `derivation` object and the derivation is registered
 * as observer of any of the accessed observables.
 */
export function trackDerivedFunction<T>(derivation: IDerivation, f: () => T, context: any) {
    // pre allocate array allocation + room for variation in deps
    // array will be trimmed by bindDependencies
    changeDependenciesStateTo0(derivation);
    derivation.newObserving = new Array(derivation.observing.length + 100);
    derivation.unboundDepsCount = 0;
    derivation.runId = ++globalState.runId;
    const prevTracking = globalState.trackingDerivation;
    globalState.trackingDerivation = derivation;
    let result;
    if (globalState.disableErrorBoundaries === true) {
        result = f.call(context)
    } else {
        try {
            result = f.call(context)
        } catch (e) {
            result = new CaughtException(e)
        }
    }
    globalState.trackingDerivation = prevTracking;
    bindDependencies(derivation);
    return result
}

/**
 * diffs newObserving with observing.
 * update observing to be newObserving with unique observables
 * notify observers that become observed/unobserved
 */
function bindDependencies(derivation: IDerivation) {
    // invariant(derivation.dependenciesState !== IDerivationState.NOT_TRACKING, "INTERNAL ERROR bindDependencies expects derivation.dependenciesState !== -1");
    const prevObserving = derivation.observing;
    const observing = (derivation.observing = derivation.newObserving!);
    let lowestNewObservingDerivationState = IDerivationState.UP_TO_DATE;

    // Go through all new observables and check diffValue: (this list can contain duplicates):
    //   0: first occurrence, change to 1 and keep it
    //   1: extra occurrence, drop it
    let i0 = 0,
        l = derivation.unboundDepsCount;
    for (let i = 0; i < l; i++) {
        const dep = observing[ i ];
        if (dep.diffValue === 0) {
            dep.diffValue = 1;
            if (i0 !== i) {
                observing[ i0 ] = dep
            }
            i0++
        }

        // Upcast is 'safe' here, because if dep is IObservable, `dependenciesState` will be undefined,
        // not hitting the condition
        if (((dep as any) as IDerivation).dependenciesState > lowestNewObservingDerivationState) {
            lowestNewObservingDerivationState = ((dep as any) as IDerivation).dependenciesState
        }
    }
    observing.length = i0;

    derivation.newObserving = null; // newObserving shouldn't be needed outside tracking (statement moved down to work around FF bug, see #614)

    // Go through all old observables and check diffValue: (it is unique after last bindDependencies)
    //   0: it's not in new observables, unobserve it
    //   1: it keeps being observed, don't want to notify it. change to 0
    l = prevObserving.length;
    while (l--) {
        const dep = prevObserving[ l ];
        if (dep.diffValue === 0) {
            removeObserver(dep, derivation)
        }
        dep.diffValue = 0
    }

    // Go through all new observables and check diffValue: (now it should be unique)
    //   0: it was set to 0 in last loop. don't need to do anything.
    //   1: it wasn't observed, let's observe it. set back to 0
    while (i0--) {
        const dep = observing[ i0 ];
        if (dep.diffValue === 1) {
            dep.diffValue = 0;
            addObserver(dep, derivation)
        }
    }

    // Some new observed derivations may become stale during this derivation computation
    // so they have had no chance to propagate staleness (#916)
    if (lowestNewObservingDerivationState !== IDerivationState.UP_TO_DATE) {
        derivation.dependenciesState = lowestNewObservingDerivationState;
        derivation.onBecomeStale()
    }
}

export function clearObserving(derivation: IDerivation) {
    // invariant(globalState.inBatch > 0, "INTERNAL ERROR clearObserving should be called only inside batch");
    const obs = derivation.observing;
    derivation.observing = [];
    let i = obs.length;
    while (i--) removeObserver(obs[ i ], derivation);

    derivation.dependenciesState = IDerivationState.NOT_TRACKING
}

export function untracked<T>(action: () => T): T {
    const prev = untrackedStart();
    const res = action();
    untrackedEnd(prev);
    return res
}

export function untrackedStart(): IDerivation | null {
    const prev = globalState.trackingDerivation;
    globalState.trackingDerivation = null;
    return prev
}

export function untrackedEnd(prev: IDerivation | null) {
    globalState.trackingDerivation = prev
}

/**
 * needed to keep `lowestObserverState` correct. when changing from (2 or 1) to 0
 *
 */
export function changeDependenciesStateTo0(derivation: IDerivation) {
    if (derivation.dependenciesState === IDerivationState.UP_TO_DATE) {
        return
    }
    derivation.dependenciesState = IDerivationState.UP_TO_DATE;

    const obs = derivation.observing;
    let i = obs.length;
    while (i--) obs[ i ].lowestObserverState = IDerivationState.UP_TO_DATE
}