// @flow strict
import React, {
  Component as ReactComponent,
  type ComponentType,
  type Node,
} from 'react';
import PropTypes from 'prop-types';
import debounce from './debounce.js';
import FetchItems from './FetchItems.js';
import styles from './Masonry.css';
import ScrollContainer from './ScrollContainer.js';
import throttle from './throttle.js';
import type { Cache } from './Cache.js';
import MeasurementStore from './MeasurementStore.js';
import {
  getElementHeight,
  getRelativeScrollTop,
  getScrollPos,
} from './scrollUtils.js';
import {
  DefaultLayoutSymbol,
  UniformRowLayoutSymbol,
} from './legacyLayoutSymbols.js';
import defaultLayout from './defaultLayout.js';
import uniformRowLayout from './uniformRowLayout.js';
import fullWidthLayout from './fullWidthLayout.js';
import LegacyMasonryLayout from './layouts/MasonryLayout.js';
import LegacyUniformRowLayout from './layouts/UniformRowLayout.js';

type Layout =
  | typeof DefaultLayoutSymbol
  | typeof UniformRowLayoutSymbol
  | LegacyMasonryLayout
  | LegacyUniformRowLayout
  | 'basic'
  | 'basicCentered'
  | 'flexible'
  | 'uniformRow';

type Props<T> = {|
  columnWidth?: number,
  comp: ComponentType<{|
    data: T,
    itemIdx: number,
    isMeasuring: boolean,
  |}>,
  flexible?: boolean,
  gutterWidth?: number,
  items: $ReadOnlyArray<T>,
  measurementStore?: Cache<T, *>,
  minCols: number,
  layout?: Layout,
  // Support legacy loadItems usage.
  // TODO: Simplify non falsey flowtype.
  loadItems?:
    | false
    | ((
        ?{|
          from: number,
        |}
      ) => void | boolean | { ... }),
  scrollContainer?: () => HTMLElement,
  virtualBoundsTop?: number,
  virtualBoundsBottom?: number,
  virtualize?: boolean,
|};

type State<T> = {|
  measurementStore: Cache<T, *>,
  hasPendingMeasurements: boolean,
  isFetching: boolean,
  items: $ReadOnlyArray<T>,
  scrollTop: number,
  width: ?number,
|};

const RESIZE_DEBOUNCE = 300;
// Multiplied against container height.
// The amount of extra buffer space for populating visible items.
const VIRTUAL_BUFFER_FACTOR = 0.7;

const layoutNumberToCssDimension = (n) => (n !== Infinity ? n : undefined);

export default class Masonry<T: { ... }> extends ReactComponent<
  Props<T>,
  State<T>
> {
  static createMeasurementStore<T1: { ... }, T2>(): MeasurementStore<T1, T2> {
    return new MeasurementStore();
  }

  /**
   * Delays resize handling in case the scroll container is still being resized.
   */
  // $FlowFixMe[signature-verification-failure]
  handleResize = debounce(() => {
    if (this.gridWrapper) {
      this.setState({ width: this.gridWrapper.clientWidth });
    }
  }, RESIZE_DEBOUNCE);

  // Using throttle here to schedule the handler async, outside of the event
  // loop that produced the event.
  // $FlowFixMe[signature-verification-failure]
  updateScrollPosition = throttle(() => {
    if (!this.scrollContainer) {
      return;
    }
    const scrollContainer = this.scrollContainer.getScrollContainerRef();

    if (!scrollContainer) {
      return;
    }

    this.setState({
      scrollTop: getScrollPos(scrollContainer),
    });
  });

  // $FlowFixMe[signature-verification-failure]
  measureContainerAsync = debounce(() => {
    this.measureContainer();
  }, 0);

  containerHeight: number;

  containerOffset: number;

  gridWrapper: ?HTMLElement;

  insertAnimationFrame: AnimationFrameID;

  measureTimeout: TimeoutID;

  scrollContainer: ?ScrollContainer;

  static propTypes = {
    /**
     * The preferred/target item width. If `flexible` is set, the item width will
     * grow to fill column space, and shrink to fit if below min columns.
     */
    columnWidth: PropTypes.number,

    /**
     * The component to render.
     */
    comp: PropTypes.func.isRequired,

    /**
     * The preferred/target item width. Item width will grow to fill
     * column space, and shrink to fit if below min columns.
     */
    flexible: PropTypes.bool,

    /**
     * The amount of space between each item.
     */
    gutterWidth: PropTypes.number,

    /**
     * An array of all objects to display in the grid.
     */
    items: PropTypes.arrayOf(PropTypes.shape({})).isRequired,

    /**
     * Measurement Store
     */
    measurementStore: PropTypes.instanceOf(MeasurementStore),

    /**
     * Layout system to use for items
     */
    layout: PropTypes.oneOfType([
      PropTypes.instanceOf(LegacyMasonryLayout),
      PropTypes.instanceOf(LegacyUniformRowLayout),
      PropTypes.symbol,
      PropTypes.string,
    ]),

    /**
     * A callback which the grid calls when we need to load more items as the user scrolls.
     * The callback should update the state of the items, and pass those in as props
     * to this component.
     */
    loadItems: PropTypes.func,

    /**
     * Minimum number of columns to display.
     */
    minCols: PropTypes.number,

    /**
     * Function that the grid calls to get the scroll container.
     * This is required if the grid is expected to be scrollable.
     */
    scrollContainer: PropTypes.func,

    /**
     * Whether or not to use actual virtualization
     */
    virtualize: PropTypes.bool,
  };

  static defaultProps: {|
    columnWidth?: number,
    layout?: Layout,
    loadItems?:
      | false
      | ((
          ?{|
            from: number,
          |}
        ) => void | boolean | { ... }),
    minCols: number,
    virtualize?: boolean,
  |} = {
    columnWidth: 236,
    minCols: 3,
    layout: 'basic',
    loadItems: () => {},
    virtualize: false,
  };

  constructor(props: Props<T>) {
    super(props);

    this.containerHeight = 0;
    this.containerOffset = 0;

    const measurementStore: Cache<T, *> =
      props.measurementStore || Masonry.createMeasurementStore();

    this.state = {
      hasPendingMeasurements: props.items.some(
        (item) => !!item && !measurementStore.has(item)
      ),
      isFetching: false,
      items: props.items,
      measurementStore,
      scrollTop: 0,
      width: undefined,
    };
  }

  /**
   * Adds hooks after the component mounts.
   */
  componentDidMount() {
    window.addEventListener('resize', this.handleResize);

    this.measureContainer();

    let { scrollTop } = this.state;
    if (this.scrollContainer != null) {
      const scrollContainer = this.scrollContainer.getScrollContainerRef();
      if (scrollContainer) {
        scrollTop = getScrollPos(scrollContainer);
      }
    }

    this.setState((prevState) => ({
      scrollTop,
      width: this.gridWrapper ? this.gridWrapper.clientWidth : prevState.width,
    }));
  }

  componentDidUpdate(prevProps: Props<T>, prevState: State<T>) {
    const { items } = this.props;
    const { measurementStore } = this.state;

    this.measureContainerAsync();

    if (prevState.width != null && this.state.width !== prevState.width) {
      measurementStore.reset();
    }
    // calculate whether we still have pending measurements
    const hasPendingMeasurements = items.some(
      (item) => !!item && !measurementStore.has(item)
    );
    if (
      hasPendingMeasurements ||
      hasPendingMeasurements !== this.state.hasPendingMeasurements ||
      prevState.width == null
    ) {
      this.insertAnimationFrame = requestAnimationFrame(() => {
        this.setState({
          hasPendingMeasurements,
        });
      });
    }
  }

  /**
   * Remove listeners when unmounting.
   */
  componentWillUnmount() {
    if (this.insertAnimationFrame) {
      cancelAnimationFrame(this.insertAnimationFrame);
    }

    // Make sure async methods are cancelled.
    this.measureContainerAsync.clearTimeout();
    this.handleResize.clearTimeout();
    this.updateScrollPosition.clearTimeout();

    window.removeEventListener('resize', this.handleResize);
  }

  static getDerivedStateFromProps(
    props: Props<T>,
    state: State<T>
  ): null | {|
    hasPendingMeasurements: boolean,
    isFetching?: boolean,
    items: $ReadOnlyArray<T>,
  |} {
    const { items } = props;
    const { measurementStore } = state;

    // whenever we're receiving new props, determine whether any items need to be measured
    // TODO - we should treat items as immutable
    const hasPendingMeasurements = items.some(
      (item) => !measurementStore.has(item)
    );

    // Shallow compare all items, if any change reflow the grid.
    for (let i = 0; i < items.length; i += 1) {
      // We've reached the end of our current props and everything matches.
      // If we hit this case it means we need to insert new items.
      if (state.items[i] === undefined) {
        return {
          hasPendingMeasurements,
          items,
          isFetching: false,
        };
      }

      // Reset grid items when:
      if (
        // An item object ref does not match.
        items[i] !== state.items[i] ||
        // Or less items than we currently have are passed in.
        items.length < state.items.length
      ) {
        return {
          hasPendingMeasurements,
          items,
          isFetching: false,
        };
      }
    }

    // Reset items if new items array is empty.
    if (items.length === 0 && state.items.length > 0) {
      return {
        hasPendingMeasurements,
        items,
        isFetching: false,
      };
    }
    if (hasPendingMeasurements !== state.hasPendingMeasurements) {
      // make sure we always update hasPendingMeasurements
      return {
        hasPendingMeasurements,
        items,
      };
    }

    // Return null to indicate no change to state.
    return null;
  }

  setGridWrapperRef: (ref: ?HTMLElement) => void = (ref: ?HTMLElement) => {
    this.gridWrapper = ref;
  };

  setScrollContainerRef: (ref: ?ScrollContainer) => void = (
    ref: ?ScrollContainer
  ) => {
    this.scrollContainer = ref;
  };

  fetchMore: () => void = () => {
    const { loadItems, items } = this.props;
    if (loadItems && typeof loadItems === 'function') {
      this.setState(
        {
          isFetching: true,
        },
        () => loadItems({ from: items.length })
      );
    }
  };

  measureContainer() {
    if (this.scrollContainer != null) {
      const { scrollContainer } = this;
      const scrollContainerRef = scrollContainer.getScrollContainerRef();
      if (scrollContainerRef) {
        this.containerHeight = getElementHeight(scrollContainerRef);
        const el = this.gridWrapper;
        if (el instanceof HTMLElement) {
          const relativeScrollTop = getRelativeScrollTop(scrollContainerRef);
          this.containerOffset =
            el.getBoundingClientRect().top + relativeScrollTop;
        }
      }
    }
  }

  /**
   * Clear measurements/positions and force a reflow of the entire grid.
   * Only use this if absolutely necessary - ex: We need to reflow items if the
   * number of columns we would display should change after a resize.
   */
  reflow() {
    const { measurementStore } = this.props;

    if (measurementStore) {
      measurementStore.reset();
    }
    this.state.measurementStore.reset();

    this.measureContainer();
    this.forceUpdate();
  }

  // $FlowFixMe[signature-verification-failure]
  renderMasonryComponent = (itemData: T, idx: number, position: *) => {
    const {
      comp: Component,
      scrollContainer,
      virtualize,
      virtualBoundsTop,
      virtualBoundsBottom,
    } = this.props;
    const { top, left, width, height } = position;

    let isVisible;
    if (scrollContainer) {
      const virtualBuffer = this.containerHeight * VIRTUAL_BUFFER_FACTOR;
      const offsetScrollPos = this.state.scrollTop - this.containerOffset;
      const viewportTop = virtualBoundsTop
        ? offsetScrollPos - virtualBoundsTop
        : offsetScrollPos - virtualBuffer;
      const viewportBottom = virtualBoundsBottom
        ? offsetScrollPos + this.containerHeight + virtualBoundsBottom
        : offsetScrollPos + this.containerHeight + virtualBuffer;

      isVisible = !(
        position.top + position.height < viewportTop ||
        position.top > viewportBottom
      );
    } else {
      // if no scroll container is passed in, items should always be visible
      isVisible = true;
    }

    const itemComponent = (
      <div
        key={`item-${idx}`}
        className={[styles.Masonry__Item, styles.Masonry__Item__Mounted].join(
          ' '
        )}
        data-grid-item
        style={{
          top: 0,
          left: 0,
          transform: `translateX(${left}px) translateY(${top}px)`,
          WebkitTransform: `translateX(${left}px) translateY(${top}px)`,
          width: layoutNumberToCssDimension(width),
          height: layoutNumberToCssDimension(height),
        }}
      >
        <Component data={itemData} itemIdx={idx} isMeasuring={false} />
      </div>
    );

    return virtualize ? (isVisible && itemComponent) || null : itemComponent;
  };

  render(): Node {
    const {
      columnWidth,
      comp: Component,
      flexible,
      gutterWidth: gutter,
      items,
      layout,
      minCols,
      scrollContainer,
    } = this.props;
    const { hasPendingMeasurements, measurementStore, width } = this.state;

    let getPositions;

    if ((flexible || layout === 'flexible') && width !== null) {
      getPositions = fullWidthLayout({
        gutter,
        cache: measurementStore,
        minCols,
        idealColumnWidth: columnWidth,
        width,
      });
    } else if (
      layout === UniformRowLayoutSymbol ||
      layout instanceof LegacyUniformRowLayout ||
      layout === 'uniformRow'
    ) {
      getPositions = uniformRowLayout({
        cache: measurementStore,
        columnWidth,
        gutter,
        minCols,
        width,
      });
    } else {
      getPositions = defaultLayout({
        cache: measurementStore,
        columnWidth,
        gutter,
        justify: layout === 'basicCentered' ? 'center' : 'start',
        minCols,
        rawItemCount: items.length,
        width,
      });
    }

    let gridBody;
    if (width == null && hasPendingMeasurements) {
      // When hyrdating from a server render, we don't have the width of the grid
      // and the measurement store is empty
      gridBody = (
        <div
          className={styles.Masonry}
          style={{ height: 0, width: '100%' }}
          ref={this.setGridWrapperRef}
        >
          {items
            .filter((item) => item)
            .map((item, i) => (
              <div // keep this in sync with renderMasonryComponent
                className="static"
                data-grid-item
                key={i}
                style={{
                  top: 0,
                  left: 0,
                  transform: 'translateX(0px) translateY(0px)',
                  WebkitTransform: 'translateX(0px) translateY(0px)',
                  width:
                    flexible || layout === 'flexible'
                      ? undefined
                      : layoutNumberToCssDimension(columnWidth), // we can't set a width for server rendered flexible items
                }}
                ref={(el) => {
                  if (el && !(flexible || layout === 'flexible')) {
                    // only measure flexible items on client
                    measurementStore.set(item, el.clientHeight);
                  }
                }}
              >
                <Component data={item} itemIdx={i} isMeasuring={false} />
              </div>
            ))}
        </div>
      );
    } else if (width == null) {
      // When the width is empty (usually after a re-mount) render an empty
      // div to collect the width for layout
      gridBody = <div style={{ width: '100%' }} ref={this.setGridWrapperRef} />;
    } else {
      // Full layout is possible
      const itemsToRender = items.filter(
        (item) => item && measurementStore.has(item)
      );
      const itemsToMeasure = items
        .filter((item) => item && !measurementStore.has(item))
        .slice(0, minCols);

      // $FlowFixMe[incompatible-call]
      const positions = getPositions(itemsToRender);
      // $FlowFixMe[incompatible-call]
      const measuringPositions = getPositions(itemsToMeasure);
      // Math.max() === -Infinity when there are no positions
      const height = positions.length
        ? Math.max(...positions.map((pos) => pos.top + pos.height))
        : 0;
      gridBody = (
        <div style={{ width: '100%' }} ref={this.setGridWrapperRef}>
          <div className={styles.Masonry} style={{ height, width }}>
            {itemsToRender.map((item, i) =>
              // $FlowFixMe[incompatible-call]
              this.renderMasonryComponent(item, i, positions[i])
            )}
          </div>
          <div className={styles.Masonry} style={{ width }}>
            {itemsToMeasure.map((data, i) => {
              // itemsToMeasure is always the length of minCols, so i will always be 0..minCols.length
              // we normalize the index here relative to the item list as a whole so that itemIdx is correct
              // and so that React doesnt reuse the measurement nodes
              const measurementIndex = itemsToRender.length + i;
              const position = measuringPositions[i];
              return (
                <div
                  key={`measuring-${measurementIndex}`}
                  style={{
                    visibility: 'hidden',
                    position: 'absolute',
                    top: layoutNumberToCssDimension(position.top),
                    left: layoutNumberToCssDimension(position.left),
                    width: layoutNumberToCssDimension(position.width),
                    height: layoutNumberToCssDimension(position.height),
                  }}
                  ref={(el) => {
                    if (el) {
                      measurementStore.set(data, el.clientHeight);
                    }
                  }}
                >
                  <Component
                    data={data}
                    itemIdx={measurementIndex}
                    isMeasuring
                  />
                </div>
              );
            })}
          </div>

          {this.scrollContainer && (
            <FetchItems
              containerHeight={this.containerHeight}
              fetchMore={this.fetchMore}
              isFetching={
                this.state.isFetching || this.state.hasPendingMeasurements
              }
              scrollHeight={height + this.containerOffset}
              scrollTop={this.state.scrollTop}
            />
          )}
        </div>
      );
    }

    return scrollContainer ? (
      <ScrollContainer
        ref={this.setScrollContainerRef}
        onScroll={this.updateScrollPosition}
        scrollContainer={scrollContainer}
      >
        {gridBody}
      </ScrollContainer>
    ) : (
      gridBody
    );
  }
}
