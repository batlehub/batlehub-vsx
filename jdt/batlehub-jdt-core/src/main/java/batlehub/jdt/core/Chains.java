package batlehub.jdt.core;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.jdt.core.CompletionContext;
import org.eclipse.jdt.core.CompletionProposal;
import org.eclipse.jdt.core.CompletionRequestor;
import org.eclipse.jdt.core.Flags;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IMember;
import org.eclipse.jdt.core.IMethod;
import org.eclipse.jdt.core.IType;
import org.eclipse.jdt.core.JavaModelException;
import org.eclipse.jdt.internal.ui.text.Chain;
import org.eclipse.jdt.internal.ui.text.ChainElement;
import org.eclipse.jdt.internal.ui.text.ChainElement.ElementType;
import org.eclipse.jdt.internal.ui.text.ChainElementAnalyzer;
import org.eclipse.jdt.internal.ui.text.ChainFinder;
import org.eclipse.jdt.internal.ui.text.ChainType;

/**
 * The chain delegate of RFC 0012 phase 2: the server's own {@link ChainFinder}
 * (from org.eclipse.jdt.core.manipulation), called with a wall-clock budget,
 * without the stock computer's refusal of primitive and JDK expected types,
 * and with labels built here — the stock computer's drop the `()` of every
 * segment but the last (§11 Measured, finding 3).
 */
public final class Chains {
  private Chains() {}

  /**
   * Decision 12. The finder matches a member by its *name* against this list
   * (and a type by its qualified name), so Object's members are named: a chain
   * ending in `hashCode()` or `toString()` is noise for every `int` and `String`.
   */
  static final List<String> IGNORED = List.of("java.lang.Object", "hashCode", "toString", "getClass", "clone", "equals");

  /** The walk stops here; rows are cut to {@link #MAX_ROWS} after ranking. */
  static final int MAX_CHAINS = 200;
  static final int MAX_ROWS = 20;

  /** One proposal: what the core turns into a CompletionItem. */
  record Row(String label, int depth, int locality, boolean method) {
    Map<String, Object> toMap(int rank) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("label", label);
      m.put("insertText", label);
      m.put("depth", depth);
      m.put("locality", locality);
      m.put("kind", method ? "method" : "field");
      m.put("rank", rank);
      return m;
    }
  }

  record Result(List<Row> rows, boolean truncated) {}

  // ponytail: keyed by the source with the typed prefix cut out, so typing the
  // next character of a prefix hits it and any other edit to this file misses;
  // an edit to *another* file (a new getter on Config) is not seen until this
  // one changes. Listen to the server's classpath/workspace events if that bites.
  private static final Map<String, Result> CACHE =
      java.util.Collections.synchronizedMap(new LinkedHashMap<>(32, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Result> e) {
          return size() > 32;
        }
      });

  /** The command's answer: `{ rows: [...], truncated }`. */
  public static Map<String, Object> find(ICompilationUnit icu, int offset, long budgetMs, int maxDepth) throws JavaModelException {
    String src = icu.getSource();
    int start = tokenStart(src, offset);
    String key = icu.getHandleIdentifier() + "|" + start + "|" + maxDepth + "|" + (src.substring(0, start) + src.substring(Math.min(offset, src.length()))).hashCode();
    Result r = CACHE.get(key);
    boolean cached = r != null;
    long t0 = System.nanoTime();
    if (r == null) {
      r = search(icu, offset, budgetMs <= 0 ? 3000 : budgetMs, maxDepth);
      // A truncated set is not the answer: the next keystroke may have the time.
      if (!r.truncated()) CACHE.put(key, r);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    List<Map<String, Object>> rows = new ArrayList<>();
    for (int i = 0; i < r.rows().size(); i++) rows.add(r.rows().get(i).toMap(i));
    out.put("rows", rows);
    out.put("truncated", r.truncated());
    out.put("cached", cached);
    out.put("ms", (System.nanoTime() - t0) / 1_000_000);
    return out;
  }

  private static Result search(ICompilationUnit icu, int offset, long budgetMs, int maxDepth) throws JavaModelException {
    CompletionContext ctx = context(icu, offset);
    if (ctx == null || ctx.getExpectedTypesSignatures() == null || ctx.getExpectedTypesSignatures().length == 0) return new Result(List.of(), false);
    if (ctx.getTokenLocation() == CompletionContext.TL_CONSTRUCTOR_START || "new".equals(String.valueOf(ctx.getToken()))) return new Result(List.of(), false);
    List<ChainType> expected = ChainElementAnalyzer.resolveBindingsForExpectedTypes(icu.getJavaProject(), ctx);
    IJavaElement enclosing = ctx.getEnclosingElement();
    IType here = enclosing == null ? null : (IType) (enclosing instanceof IType t ? t : enclosing.getAncestor(IJavaElement.TYPE));
    if (here == null) here = icu.findPrimaryType();
    if (here == null) return new Result(List.of(), false);

    List<ChainElement> roots = new ArrayList<>();
    for (IJavaElement e : ctx.getVisibleElements(null)) {
      if (ChainFinder.isFromExcludedType(IGNORED, e)) continue;
      ChainElement ce = new ChainElement(e, false);
      // A root no row can start from (row() drops arrays and members with
      // parameters) still spends MAX_CHAINS: `main`'s `String[] args` alone
      // filled it, and `config.getServer().getPort()` was never reached.
      if (ce.getElementType() != null && ce.getReturnTypeDimension() == 0 && !(e instanceof IMethod m && m.getNumberOfParameters() > 0)) roots.add(ce);
    }
    ChainFinder finder = new ChainFinder(expected, IGNORED, here);
    AtomicBoolean done = new AtomicBoolean();
    AtomicBoolean cut = new AtomicBoolean();
    CompletableFuture.delayedExecutor(budgetMs, TimeUnit.MILLISECONDS).execute(() -> {
      if (!done.get()) {
        cut.set(true);
        finder.cancel();
      }
    });
    // Decision 11: depth 1 (a plain member of the expected type) is JDT's own proposal.
    finder.startChainSearch(roots, MAX_CHAINS, 2, maxDepth);
    done.set(true);

    int expectedDims = expected.isEmpty() ? 0 : expected.get(0).getDimension();
    List<Row> rows = new ArrayList<>();
    for (Chain c : new ArrayList<>(finder.getChains())) {
      Row row = row(c, here, expectedDims);
      if (row != null) rows.add(row);
    }
    return new Result(rank(rows), cut.get());
  }

  /** `codeComplete` only for its extended context: expected type, scope, enclosing member. */
  private static CompletionContext context(ICompilationUnit icu, int offset) throws JavaModelException {
    CompletionContext[] out = new CompletionContext[1];
    CompletionRequestor req = new CompletionRequestor(true) {
      @Override
      public void acceptContext(CompletionContext c) {
        out[0] = c;
      }

      @Override
      public void accept(CompletionProposal p) {}
    };
    req.setRequireExtendedContext(true);
    icu.codeComplete(offset, req);
    return out[0] != null && out[0].isExtended() ? out[0] : null;
  }

  /**
   * Null when the chain is not one the RFC inserts: a member with parameters
   * (argument guessing is a non-goal), or an array met on the way.
   */
  static Row row(Chain c, IType here, int expectedDims) {
    List<ChainElement> els = c.getElements();
    StringBuilder label = new StringBuilder();
    for (int i = 0; i < els.size(); i++) {
      ChainElement e = els.get(i);
      if (e.getElementType() == ElementType.TYPE) return null;
      if (e.getReturnTypeDimension() != (i == els.size() - 1 ? expectedDims : 0)) return null;
      if (i > 0) label.append('.');
      label.append(e.getElement().getElementName());
      if (e.getElementType() == ElementType.METHOD) {
        if (((IMethod) e.getElement()).getNumberOfParameters() > 0) return null;
        label.append("()");
      }
    }
    return new Row(label.toString(), els.size(), locality(els.get(0), here), els.get(els.size() - 1).getElementType() == ElementType.METHOD);
  }

  /** §4.2 rule 1: local or parameter 0, member of this type 1, inherited or static 2. */
  static int locality(ChainElement root, IType here) {
    if (root.getElementType() == ElementType.LOCAL_VARIABLE) return 0;
    if (root.getElement() instanceof IMember m) {
      try {
        if (here.equals(m.getDeclaringType()) && !Flags.isStatic(m.getFlags())) return 1;
      } catch (JavaModelException e) {
        // fall through: treated as farther away
      }
    }
    return 2;
  }

  /** §4.2: locality, then depth, then the label; cut to {@link #MAX_ROWS}. */
  static List<Row> rank(List<Row> rows) {
    return rows.stream()
        .distinct()
        .sorted(Comparator.comparingInt(Row::locality).thenComparingInt(Row::depth).thenComparing(Row::label))
        .limit(MAX_ROWS)
        .toList();
  }

  /** Where the identifier being typed at `offset` starts. */
  static int tokenStart(String src, int offset) {
    int i = Math.min(offset, src.length());
    while (i > 0 && Character.isJavaIdentifierPart(src.charAt(i - 1))) i--;
    return i;
  }
}
