package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.CatchClause;
import org.eclipse.jdt.core.dom.CompilationUnit;

/** A catch block with no statements swallows the exception. No fix: only the author knows what belongs there. */
public final class EmptyCatch extends Base {
  public EmptyCatch() {
    super("correctness", "emptyCatch", "warning");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(CatchClause c) {
        if (c.getBody().statements().isEmpty() && !c.getException().getName().getIdentifier().startsWith("ignore"))
          out.add(new Finding(EmptyCatch.this, c.getException(), "Empty catch block swallows the exception (name it 'ignored' if that is intended)", null, null));
        return true;
      }
    });
  }
}
